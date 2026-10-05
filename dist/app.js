(() => {
  "use strict";
  const CURRENT_CODE_KEY = "pitchloop.live-code.v2";
  const MAX_TEAMS = 32;
  const palette = ["cyan", "orange", "lime", "violet", "blue", "rose", "gold", "mint"];
  const $ = (id) => document.getElementById(id);
  const uid = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const clean = (value, max = 36) => String(value || "").trim().slice(0, max);
  const config = window.PITCHLOOP_SUPABASE;
  const db = window.supabase?.createClient(config?.url, config?.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  let user = null;
  let eventRecord = null;
  let state = freshState();
  let isOwner = false;
  let realtimeChannel = null;
  let timerHandle = null;
  let wakeLock = null;
  let pendingAction = null;
  let undoState = null;
  let toastTimer = null;
  let timeUpAnnounced = false;
  let pendingSubmissions = [];
  let syncing = false;
  let pendingWrites = 0;
  let saveChain = Promise.resolve();
  let eventGeneration = 0;
  let eventMutationPending = false;
  let writeEpoch = 0;
  let deferredEventRow = null;

  function freshState(name = "Hangar Night", duration = 420) {
    return { version: 2, eventName: name, duration, remaining: duration, endAt: null, running: false, game: 1, teams: [], active: [], queue: [] };
  }
  function makeTeam(name, rep, players = []) {
    return { id: uid(), name: clean(name), rep: clean(rep), players: players.map((p) => clean(p)).filter(Boolean).slice(0, 20), color: palette[Math.floor(Math.random() * palette.length)] };
  }
  function normalizeState(raw, fallbackName = "Hangar Night") {
    const next = raw && typeof raw === "object" ? structuredClone(raw) : freshState(fallbackName);
    next.version = 2;
    next.eventName = clean(next.eventName || fallbackName, 42) || "Hangar Night";
    next.duration = Math.max(60, Math.min(3600, Number(next.duration) || 420));
    next.remaining = Number.isFinite(Number(next.remaining)) ? Math.max(0, Math.min(next.duration, Number(next.remaining))) : next.duration;
    next.endAt = Number.isFinite(Number(next.endAt)) ? Number(next.endAt) : null;
    next.running = Boolean(next.running && next.endAt);
    next.game = Math.max(1, Math.floor(Number(next.game) || 1));
    next.teams = Array.isArray(next.teams) ? next.teams.map(normalizeTeam).filter(Boolean).slice(0, MAX_TEAMS) : [];
    const ids = new Set(next.teams.map((team) => team.id));
    const seen = new Set();
    next.active = Array.isArray(next.active) ? next.active.filter((id) => ids.has(id) && !seen.has(id) && seen.add(id)).slice(0, 2) : [];
    next.queue = Array.isArray(next.queue) ? next.queue.filter((id) => ids.has(id) && !seen.has(id) && seen.add(id)) : [];
    next.teams.forEach((team) => { if (!seen.has(team.id)) next.queue.push(team.id); });
    while (next.active.length < 2 && next.queue.length) next.active.push(next.queue.shift());
    return next;
  }
  function normalizeTeam(raw) {
    if (!raw || typeof raw !== "object") return null;
    const team = { id: clean(raw.id, 80) || uid(), name: clean(raw.name), rep: clean(raw.rep), players: Array.isArray(raw.players) ? raw.players.map((p) => clean(p)).filter(Boolean).slice(0, 20) : [], color: palette.includes(raw.color) ? raw.color : palette[Math.floor(Math.random() * palette.length)] };
    return team.name && team.rep ? team : null;
  }
  const getTeam = (id) => state.teams.find((team) => team.id === id);
  const initials = (name) => clean(name).split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "FC";
  function escapeText(value) { const node = document.createElement("span"); node.textContent = value; return node.innerHTML; }
  function escapeAttr(value) { return escapeText(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
  function announce(message) { $("announcer").textContent = ""; requestAnimationFrame(() => { $("announcer").textContent = message; }); }
  function errorMessage(error, fallback = "Something went wrong. Please try again.") { return clean(error?.message || fallback, 160); }

  async function initialize() {
    bindEvents();
    setLandingBusy(true, "Connecting securely…");
    if (!db) return showLandingError("Could not load the live-event service. Check your connection and refresh.");
    try {
      const { data: sessionData, error: sessionError } = await db.auth.getSession();
      if (sessionError) throw sessionError;
      if (sessionData.session) {
        const { data: userData, error: userError } = await db.auth.getUser();
        if (userError || !userData.user) throw userError || new Error("Your organizer session could not be verified. Refresh to try again.");
        user = userData.user;
      } else {
        const { data, error } = await db.auth.signInAnonymously();
        if (error) throw error;
        user = data.user;
      }
      setLandingBusy(false, "Ready");
      const hashCode = new URLSearchParams(location.hash.slice(1)).get("event");
      const remembered = localStorage.getItem(CURRENT_CODE_KEY);
      const requestedCode = clean(hashCode || remembered, 6).toUpperCase();
      if (requestedCode) {
        try { await joinEvent(requestedCode, { quiet: true }); }
        catch { showLanding(); if (hashCode) showLandingError("That event could not be opened. Check the code and try again."); }
      } else showLanding();
    } catch (error) { showLandingError(errorMessage(error, "Anonymous sign-in is unavailable. Confirm it is enabled in Supabase."), { disableForms: true }); }
    registerWebMCP();
  }

  function showLanding() {
    $("landing-view").hidden = false; $("event-view").hidden = true;
    unsubscribeRealtime(); clearInterval(timerHandle); timerHandle = null;
  }
  function showLandingError(message, { disableForms = false } = {}) { showLanding(); $("landing-status").textContent = message; $("landing-status").classList.add("error"); if (disableForms) document.querySelectorAll(".landing-form button").forEach((button) => { button.disabled = true; }); }
  function showEvent() { $("landing-view").hidden = true; $("event-view").hidden = false; $("landing-status").classList.remove("error"); }

  async function createEvent(name, minutes) {
    setLandingBusy(true, "Creating event…");
    try {
      const duration = Math.max(60, Math.min(3600, Math.round(Number(minutes) * 60)));
      const { data, error } = await db.rpc("create_pitch_event", { p_name: clean(name, 42), p_duration_seconds: duration });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error("The event was not created.");
      await connectToEvent(row);
      showToast("Live event created", false);
    } finally { setLandingBusy(false); }
  }
  async function joinEvent(code, { quiet = false } = {}) {
    if (!quiet) setLandingBusy(true, "Joining event…");
    try {
      const normalized = clean(code, 6).toUpperCase();
      if (normalized.length !== 6) throw new Error("Enter the six-character event code.");
      const { data, error } = await db.rpc("join_pitch_event", { p_code: normalized });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error("Event not found.");
      await connectToEvent(row);
      if (!quiet) showToast("Joined live event", false);
    } finally { if (!quiet) setLandingBusy(false); }
  }
  function setLandingBusy(busy, message = "Ready") {
    $("landing-status").textContent = message; $("landing-status").classList.remove("error");
    document.querySelectorAll(".landing-form button").forEach((button) => { button.disabled = busy; });
  }

  async function connectToEvent(row) {
    eventGeneration += 1;
    writeEpoch += 1;
    pendingWrites = 0;
    syncing = false;
    eventMutationPending = false;
    deferredEventRow = null;
    eventRecord = row;
    isOwner = row.owner_id === user.id;
    state = normalizeState(row.state, row.name);
    localStorage.setItem(CURRENT_CODE_KEY, row.code);
    history.replaceState(null, "", `${location.pathname}#event=${row.code}`);
    showEvent(); render(); startTimerLoop(); subscribeRealtime();
    if (isOwner) await loadSubmissions();
  }
  function applyEventRow(row) {
    if (!row || row.id !== eventRecord?.id) return;
    if (pendingWrites > 0) {
      deferredEventRow = row;
      return;
    }
    eventRecord = row;
    state = normalizeState(row.state, row.name); isOwner = row.owner_id === user.id; render();
  }
  function applyDeferredEventRow() {
    if (!deferredEventRow || deferredEventRow.id !== eventRecord?.id) { deferredEventRow = null; return; }
    eventRecord = deferredEventRow;
    deferredEventRow = null;
  }
  function subscribeRealtime() {
    unsubscribeRealtime();
    realtimeChannel = db.channel(`pitch-event-${eventRecord.id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "pitch_events", filter: `id=eq.${eventRecord.id}` }, ({ new: row }) => applyEventRow(row))
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "pitch_events", filter: `id=eq.${eventRecord.id}` }, () => { leaveEvent(); showLandingError("This event was deleted by its organizer."); })
      .on("postgres_changes", { event: "*", schema: "public", table: "pitch_team_submissions", filter: `event_id=eq.${eventRecord.id}` }, () => { if (isOwner) void loadSubmissions(); })
      .subscribe((status) => {
        $("sync-chip").textContent = status === "SUBSCRIBED" ? "Live" : status === "CHANNEL_ERROR" || status === "TIMED_OUT" ? "Reconnecting…" : "Connecting…";
        $("sync-chip").classList.toggle("online", status === "SUBSCRIBED");
      });
  }
  function unsubscribeRealtime() { if (realtimeChannel && db) void db.removeChannel(realtimeChannel); realtimeChannel = null; }

  async function syncState({ silent = false } = {}) {
    if (!isOwner || !eventRecord) return;
    const payload = structuredClone(state), name = state.eventName, eventId = eventRecord.id, generation = eventGeneration, epoch = writeEpoch;
    pendingWrites += 1; syncing = true; $("sync-chip").textContent = "Saving…";
    const write = async () => {
      if (epoch !== writeEpoch) { const superseded = new Error("A newer event version is already loaded."); superseded.code = "PITCH_SUPERSEDED"; throw superseded; }
      const expectedUpdatedAt = eventRecord?.id === eventId ? eventRecord.updated_at : null;
      const { data, error } = await db.from("pitch_events").update({ name, state: payload }).eq("id", eventId).eq("updated_at", expectedUpdatedAt).select().maybeSingle();
      if (error) throw error;
      if (!data) {
        const { data: latest, error: reloadError } = await db.from("pitch_events").select().eq("id", eventId).single();
        if (reloadError) throw reloadError;
        const conflict = new Error("This event changed on another organizer screen. The latest version has been loaded; please repeat your action.");
        conflict.code = "PITCH_CONFLICT"; conflict.latest = latest; throw conflict;
      }
      if (generation === eventGeneration && eventRecord?.id === eventId) eventRecord = data;
      return data;
    };
    const operation = saveChain.catch(() => {}).then(write);
    saveChain = operation;
    try {
      const data = await operation;
      if (generation !== eventGeneration || eventRecord?.id !== eventId) return;
      eventRecord = data;
      if (!silent) announce("Live event updated.");
    }
    catch (error) {
      if (generation === eventGeneration && eventRecord?.id === eventId && error.code === "PITCH_CONFLICT") { eventRecord = error.latest; writeEpoch += 1; $("sync-chip").textContent = "Refreshed"; showToast(error.message, false); }
      else if (generation === eventGeneration && eventRecord?.id === eventId && error.code !== "PITCH_SUPERSEDED") { $("sync-chip").textContent = "Save failed"; showToast(errorMessage(error, "Could not save the live event."), false); }
      throw error;
    }
    finally {
      if (generation !== eventGeneration || eventRecord?.id !== eventId) return;
      pendingWrites = Math.max(0, pendingWrites - 1); syncing = pendingWrites > 0;
      if (!syncing) { applyDeferredEventRow(); $("sync-chip").textContent = "Live"; $("sync-chip").classList.add("online"); state = normalizeState(eventRecord.state, eventRecord.name); render(); }
    }
  }

  function canMutateEvent() {
    if (!eventMutationPending) return true;
    showToast("Finish the current team approval first", false);
    return false;
  }

  function render() {
    if (!eventRecord) return;
    $("event-title").textContent = state.eventName;
    $("event-code").textContent = eventRecord.code;
    $("role-chip").textContent = isOwner ? "Organizer" : "Watching live";
    $("duration-label").textContent = Math.round(state.duration / 60);
    $("game-label").textContent = `Game ${String(state.game).padStart(2, "0")}`;
    $("add-team-label").textContent = isOwner ? "Add a team" : "Submit a team";
    document.querySelectorAll(".owner-only").forEach((element) => { element.hidden = !isOwner; });
    document.querySelectorAll(".viewer-only").forEach((element) => { element.hidden = isOwner; });
    const activeTeams = state.active.map(getTeam).filter(Boolean);
    $("matchup").innerHTML = [0, 1].map((slot) => teamCard(activeTeams[slot], slot)).join('<div class="versus" aria-hidden="true">VS</div>');
    const canPlay = activeTeams.length === 2;
    $("result-a").textContent = activeTeams[0] ? `${activeTeams[0].name} lost` : "Team A lost";
    $("result-b").textContent = activeTeams[1] ? `${activeTeams[1].name} lost` : "Team B lost";
    [$("result-a"), $("result-b")].forEach((button) => { button.disabled = !canPlay || !isOwner || state.queue.length < 1; });
    $("result-draw").disabled = !canPlay || !isOwner || state.queue.length < 2;
    const nextIds = state.queue.slice(0, 2);
    $("next-grid").innerHTML = [0, 1].map((index) => nextCard(getTeam(nextIds[index]), index)).join("");
    $("queue-count").textContent = `${state.queue.length} waiting`;
    const later = state.queue.slice(2);
    $("queue-list").innerHTML = later.length ? later.map((id, i) => queueRow(getTeam(id), i + 3, i + 2)).join("") : '<p class="queue-empty">The next two teams are the full queue.</p>';
    updateTimerView(); renderSubmissions();
  }
  function teamCard(team, slot) {
    if (!team) return `<article class="team-card empty-card"><span class="team-status">ON PITCH · ${slot ? "B" : "A"}</span><div class="empty-team">Waiting for a team</div></article>`;
    const count = team.players.length ? `${team.players.length} players` : "Representative";
    const remove = isOwner ? `<button class="mini-remove" data-remove="${escapeAttr(team.id)}" aria-label="Remove ${escapeAttr(team.name)}">×</button>` : "";
    return `<article class="team-card team-${slot ? "b" : "a"}">${remove}<span class="team-status">ON PITCH · ${slot ? "B" : "A"}</span><div class="kit-badge ${team.color}">${initials(team.name)}</div><h3>${escapeText(team.name)}</h3><p>${escapeText(team.rep)} · ${count}</p></article>`;
  }
  function nextCard(team, index) {
    if (!team) return `<article class="next-card empty-next"><span>NEXT ${index + 1}</span><div class="queue-avatar">—</div><strong>Waiting for a team</strong><small>${isOwner ? "Add another side" : "No team queued"}</small></article>`;
    const remove = isOwner ? `<button class="mini-remove" data-remove="${escapeAttr(team.id)}" aria-label="Remove ${escapeAttr(team.name)}">×</button>` : "";
    return `<article class="next-card">${remove}<span>NEXT ${index + 1}</span><div class="queue-avatar ${team.color}">${initials(team.name)}</div><strong>${escapeText(team.name)}</strong><small>${escapeText(team.rep)}</small></article>`;
  }
  function queueRow(team, position, queueIndex) {
    if (!team) return "";
    const actions = isOwner ? `<div class="queue-actions"><button data-move="up" data-id="${escapeAttr(team.id)}" aria-label="Move ${escapeAttr(team.name)} up">↑</button><button data-move="down" data-id="${escapeAttr(team.id)}" aria-label="Move ${escapeAttr(team.name)} down" ${queueIndex === state.queue.length - 1 ? "disabled" : ""}>↓</button><button data-remove="${escapeAttr(team.id)}" aria-label="Remove ${escapeAttr(team.name)}">×</button></div>` : "";
    return `<div class="queue-row"><span class="position">${position}</span><div class="queue-avatar small ${team.color}">${initials(team.name)}</div><div><strong>${escapeText(team.name)}</strong><small>${escapeText(team.rep)}</small></div>${actions}</div>`;
  }

  function timerValues() {
    if (!state.running || !state.endAt) return { remaining: state.remaining, overtime: 0 };
    const delta = state.endAt - Date.now();
    return delta > 0 ? { remaining: Math.ceil(delta / 1000), overtime: 0 } : { remaining: 0, overtime: Math.floor(Math.abs(delta) / 1000) };
  }
  function updateTimerView() {
    const { remaining, overtime } = timerValues();
    const minutes = Math.floor(remaining / 60), seconds = remaining % 60;
    $("timer").textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    $("timer").classList.toggle("final-minute", remaining > 0 && remaining <= 60);
    $("timer").setAttribute("aria-label", overtime ? `Time is up, ${overtime} seconds overtime` : `${minutes} minutes ${seconds} seconds remaining`);
    $("overtime").hidden = overtime === 0;
    if (overtime) $("overtime").querySelector("strong").textContent = `+${formatTime(overtime)}`;
    const ended = !state.running && state.remaining === 0;
    const canStart = state.active.length === 2 && state.remaining > 0;
    $("timer-toggle").disabled = !isOwner || (!state.running && !canStart);
    $("timer-toggle").querySelector("span").textContent = state.running ? (overtime ? "Stop overtime" : "Pause match") : ended ? "Time ended" : state.remaining < state.duration ? "Resume match" : "Start match";
    $("match-status").innerHTML = overtime ? '<span class="danger-dot"></span> Overtime' : state.running ? '<span></span> Match live' : ended ? '<span class="danger-dot"></span> Time ended' : '<span></span> Match ready';
    if (overtime && !timeUpAnnounced) { timeUpAnnounced = true; if (isOwner) navigator.vibrate?.([160, 80, 160]); announce("Regulation time ended. Overtime is counting up."); }
    if (!overtime) timeUpAnnounced = false;
  }
  function formatTime(total) { const m = Math.floor(total / 60), s = total % 60; return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`; }
  async function toggleTimer() {
    if (!isOwner || !canMutateEvent()) return;
    if (state.running) { const values = timerValues(); state.remaining = values.remaining; state.running = false; state.endAt = null; releaseWakeLock(); }
    else { if (state.active.length < 2 || state.remaining <= 0) return; state.running = true; state.endAt = Date.now() + state.remaining * 1000; try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {} }
    render(); await syncState();
  }
  async function resetTimer({ sync = true } = {}) { if (!canMutateEvent()) return; state.running = false; state.endAt = null; state.remaining = state.duration; releaseWakeLock(); render(); if (sync) await syncState(); }
  function startTimerLoop() { clearInterval(timerHandle); timerHandle = window.setInterval(updateTimerView, 250); }
  function releaseWakeLock() { if (wakeLock) void wakeLock.release?.().catch?.(() => {}); wakeLock = null; }

  function stageResult(type) {
    const requiredQueue = type === "draw" ? 2 : 1;
    if (!isOwner || !canMutateEvent() || state.active.length < 2 || state.queue.length < requiredQueue) return;
    const a = getTeam(state.active[0]), b = getTeam(state.active[1]); const incoming = state.queue.slice(0, type === "draw" ? 2 : 1).map(getTeam).filter(Boolean);
    const timerSnapshot = state.running ? { ...timerValues(), duration: state.duration } : null;
    pendingAction = { kind: "result", type, activeIds: [...state.active], rotationToken: JSON.stringify({ active: state.active, queue: state.queue }), timerSnapshot };
    if (timerSnapshot) { state.remaining = timerSnapshot.remaining; state.running = false; state.endAt = null; releaseWakeLock(); render(); void syncState({ silent: true }).catch(() => {}); }
    openSliderConfirm({ eyebrow: "CONFIRM RESULT", title: type === "draw" ? "Confirm a draw" : `${type === "a" ? a.name : b.name} lost?`, description: type === "draw" ? "Both teams rotate out. Their order at the back will be randomized." : `${type === "a" ? b.name : a.name} stays on the pitch.`, preview: `<span>OUT<br><strong>${escapeText(type === "draw" ? `${a.name} + ${b.name}` : (type === "a" ? a.name : b.name))}</strong></span><b>→</b><span>IN<br><strong>${escapeText(incoming.length ? incoming.map((team) => team.name).join(" + ") : "No waiting team")}</strong></span>`, slideLabel: "Slide to rotate" });
  }
  async function applyResult(action) {
    if (action.rotationToken !== JSON.stringify({ active: state.active, queue: state.queue }) || action.activeIds.some((id, index) => state.active[index] !== id)) { closeConfirm(); showToast("The rotation changed. Review the current teams and try again.", false); return; }
    const type = action.type;
    undoState = structuredClone(state);
    if (type === "a" || type === "b") { const slot = type === "a" ? 0 : 1; const loser = state.active[slot]; if (state.queue.length) { state.active[slot] = state.queue.shift(); state.queue.push(loser); } }
    else { const outgoing = [...state.active]; if (Math.random() < .5) outgoing.reverse(); const pool = [...state.queue, ...outgoing]; state.active = pool.splice(0, 2); state.queue = pool; }
    state.game += 1; state.running = false; state.endAt = null; state.remaining = state.duration; releaseWakeLock(); closeConfirm(); render(); await syncState(); showToast("Rotation updated", true);
  }
  function stageRemove(id) {
    if (!isOwner || !canMutateEvent()) return; const team = getTeam(id); if (!team) return; pendingAction = { kind: "remove", id };
    openSliderConfirm({ eyebrow: "REMOVE TEAM", title: `Remove ${team.name}?`, description: state.active.includes(id) ? "A waiting team will take this pitch slot and the timer will reset." : "This team will leave the live rotation.", slideLabel: "Slide to remove team" });
  }
  async function removeTeam(id) {
    undoState = structuredClone(state); const activeIndex = state.active.indexOf(id); state.teams = state.teams.filter((team) => team.id !== id); state.queue = state.queue.filter((teamId) => teamId !== id);
    if (activeIndex >= 0) { state.active.splice(activeIndex, 1); if (state.queue.length) state.active.splice(activeIndex, 0, state.queue.shift()); state.running = false; state.endAt = null; state.remaining = state.duration; releaseWakeLock(); }
    closeConfirm(); render(); await syncState(); showToast("Team removed", true);
  }
  async function addOwnerTeam(team) {
    if (!canMutateEvent()) return;
    validateNewTeam(team); state.teams.push(team); if (state.active.length < 2) state.active.push(team.id); else state.queue.push(team.id); render(); await syncState(); showToast(`${team.name} added`, false);
  }
  async function submitViewerTeam(team) {
    if (!eventRecord) return; validateNewTeam(team);
    const { error } = await db.from("pitch_team_submissions").insert({ event_id: eventRecord.id, submitter_id: user.id, team_name: team.name, representative: team.rep, players: team.players });
    if (error) throw error; showToast("Team sent for organizer approval", false); announce("Team submitted for approval.");
  }
  function validateNewTeam(team) { if (!team.name || !team.rep) throw new Error("Team name and representative are required."); if (state.teams.length >= MAX_TEAMS) throw new Error("This event already has 32 teams."); if (state.teams.some((item) => item.name.toLocaleLowerCase() === team.name.toLocaleLowerCase())) throw new Error("That team is already in this event."); }
  async function moveTeam(id, direction) { if (!isOwner || !canMutateEvent()) return; const index = state.queue.indexOf(id), next = direction === "up" ? index - 1 : index + 1; if (index < 0 || next < 0 || next >= state.queue.length) return; [state.queue[index], state.queue[next]] = [state.queue[next], state.queue[index]]; render(); await syncState({ silent: true }); }

  async function loadSubmissions() {
    if (!isOwner || !eventRecord) return;
    const { data, error } = await db.from("pitch_team_submissions").select("id,team_name,representative,players,created_at,status").eq("event_id", eventRecord.id).eq("status", "pending").order("created_at", { ascending: true });
    if (error) { showToast(errorMessage(error, "Could not load team requests."), false); return; }
    pendingSubmissions = data || []; renderSubmissions();
  }
  function renderSubmissions() {
    const section = $("submissions-section"); if (!isOwner || !pendingSubmissions.length) { section.hidden = true; return; }
    section.hidden = false; $("submission-count").textContent = `${pendingSubmissions.length} pending`;
    $("submission-list").innerHTML = pendingSubmissions.map((item) => `<article class="submission-card"><div class="queue-avatar mint">${initials(item.team_name)}</div><div><strong>${escapeText(item.team_name)}</strong><small>${escapeText(item.representative)} · ${item.players?.length || 0} players</small></div><div><button data-approve="${item.id}" type="button">Approve</button><button data-reject="${item.id}" type="button">Decline</button></div></article>`).join("");
  }
  async function approveSubmission(id) {
    if (eventMutationPending || !eventRecord) return;
    const eventId = eventRecord.id, generation = eventGeneration;
    eventMutationPending = true;
    render();
    await saveChain.catch(() => {});
    if (generation !== eventGeneration || eventRecord?.id !== eventId) return;
    pendingWrites += 1; syncing = true; $("sync-chip").textContent = "Approving…";
    const operation = saveChain.catch(() => {}).then(async () => {
      const { data, error } = await db.rpc("approve_pitch_team_submission", { p_submission_id: id });
      if (error) throw error;
      return Array.isArray(data) ? data[0] : data;
    });
    saveChain = operation;
    try {
      const row = await operation;
      if (generation !== eventGeneration || eventRecord?.id !== eventId) return;
      if (row) { eventRecord = row; state = normalizeState(row.state, row.name); }
      await loadSubmissions(); showToast("Team approved and added", false);
    } catch (error) {
      if (generation === eventGeneration && eventRecord?.id === eventId) showToast(errorMessage(error, "Could not approve that team."), false);
    } finally {
      if (generation !== eventGeneration || eventRecord?.id !== eventId) return;
      pendingWrites = Math.max(0, pendingWrites - 1); syncing = pendingWrites > 0; eventMutationPending = false;
      if (!syncing) { applyDeferredEventRow(); state = normalizeState(eventRecord.state, eventRecord.name); }
      $("sync-chip").textContent = syncing ? "Saving…" : "Live"; render();
    }
  }
  async function rejectSubmission(id) {
    const { error } = await db.from("pitch_team_submissions").update({ status: "rejected", reviewed_at: new Date().toISOString() }).eq("id", id); if (error) return showToast(errorMessage(error, "Could not decline that team."), false);
    await loadSubmissions(); showToast("Team request declined", false);
  }

  function openSliderConfirm({ eyebrow, title, description, preview = "", slideLabel }) {
    $("confirm-eyebrow").textContent = eyebrow; $("confirm-title").textContent = title; $("confirm-description").textContent = description; $("rotation-preview").innerHTML = preview; $("rotation-preview").hidden = !preview; $("slide-label").textContent = slideLabel; resetSlider(); $("confirm-dialog").showModal(); $("slide-control").focus();
  }
  function closeConfirm() { if ($("confirm-dialog").open) $("confirm-dialog").close(); pendingAction = null; resetSlider(); }
  async function cancelPending() {
    const action = pendingAction;
    closeConfirm();
    if (!action?.timerSnapshot || !isOwner || !eventRecord) return;
    const timerStillPaused = !state.running && state.endAt === null && state.remaining === action.timerSnapshot.remaining && state.duration === action.timerSnapshot.duration;
    if (!timerStillPaused || action.rotationToken !== JSON.stringify({ active: state.active, queue: state.queue }) || action.activeIds.some((id, index) => state.active[index] !== id)) { showToast("The live event changed, so the previous timer was not resumed.", false); return; }
    state.remaining = action.timerSnapshot.remaining;
    state.running = true;
    state.endAt = action.timerSnapshot.overtime > 0 ? Date.now() - action.timerSnapshot.overtime * 1000 : Date.now() + action.timerSnapshot.remaining * 1000;
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
    render(); await syncState({ silent: true }).catch(() => {});
  }
  async function commitPending() {
    const action = pendingAction; if (!action) return; pendingAction = null;
    try {
      if (action.kind === "result") await applyResult(action);
      else if (action.kind === "remove") await removeTeam(action.id);
      else if (action.kind === "delete") await deleteEvent();
    } catch (error) { closeConfirm(); showToast(errorMessage(error), false); }
  }
  function stageDeleteEvent() { if (!isOwner || !canMutateEvent()) return; pendingAction = { kind: "delete" }; openSliderConfirm({ eyebrow: "DELETE EVENT", title: `Delete ${state.eventName}?`, description: "The live link will stop working for everyone. This cannot be undone.", slideLabel: "Slide to delete event" }); }
  async function deleteEvent() { const id = eventRecord.id; const { error } = await db.from("pitch_events").delete().eq("id", id); if (error) throw error; releaseWakeLock(); closeConfirm(); leaveEvent(); showLanding(); showToast("Event deleted", false); }
  function leaveEvent() { releaseWakeLock(); eventGeneration += 1; writeEpoch += 1; pendingWrites = 0; syncing = false; eventMutationPending = false; deferredEventRow = null; unsubscribeRealtime(); localStorage.removeItem(CURRENT_CODE_KEY); history.replaceState(null, "", location.pathname); eventRecord = null; isOwner = false; state = freshState(); pendingSubmissions = []; showLanding(); }

  function eventLink() {
    const base = location.protocol === "http:" || location.protocol === "https:" ? `${location.origin}${location.pathname}` : config?.appUrl;
    return `${base || "https://pitchloop-field-rotation.jenop.chatgpt.site/"}#event=${eventRecord.code}`;
  }
  async function copyText(text, message) {
    try { await navigator.clipboard.writeText(text); showToast(message, false); }
    catch { showToast("Copy was blocked. Select and copy from the address bar.", false); }
  }
  function showToast(message, undo = false) { clearTimeout(toastTimer); $("toast-message").textContent = message; $("toast-action").hidden = !undo; $("toast").classList.add("show"); toastTimer = setTimeout(() => $("toast").classList.remove("show"), undo ? 8000 : 3600); }

  const slider = $("slide-control"), knob = $("slide-knob"), fill = $("slide-fill"); let dragStart = 0, dragging = false;
  function resetSlider() { knob.style.transform = "translateX(0)"; fill.style.width = "0"; dragging = false; }
  knob.addEventListener("pointerdown", (event) => { dragging = true; dragStart = event.clientX; knob.setPointerCapture(event.pointerId); });
  knob.addEventListener("pointermove", (event) => { if (!dragging) return; const max = slider.clientWidth - knob.offsetWidth - 8; const x = Math.max(0, Math.min(max, event.clientX - dragStart)); knob.style.transform = `translateX(${x}px)`; fill.style.width = `${x + knob.offsetWidth}px`; });
  knob.addEventListener("pointerup", (event) => { if (!dragging) return; dragging = false; const max = slider.clientWidth - knob.offsetWidth - 8; const x = Math.max(0, event.clientX - dragStart); if (x >= max * .82) void commitPending(); else resetSlider(); });
  slider.addEventListener("click", (event) => { if (event.detail === 0) { void commitPending(); return; } if (event.target === knob) return; const bounds = slider.getBoundingClientRect(); if ((event.clientX - bounds.left) / bounds.width >= .82) void commitPending(); });
  slider.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); void commitPending(); } });

  function bindEvents() {
    $("create-tab").addEventListener("click", () => selectLandingTab("create")); $("join-tab").addEventListener("click", () => selectLandingTab("join"));
    $("create-event-form").addEventListener("submit", (event) => { event.preventDefault(); void createEvent($("create-name").value, $("create-minutes").value).catch((error) => showLandingError(errorMessage(error, "Could not create the event. Has the database migration been run?"))); });
    $("join-event-form").addEventListener("submit", (event) => { event.preventDefault(); void joinEvent($("join-code").value).catch((error) => showLandingError(errorMessage(error, "Event not found. Check the code."))); });
    $("join-code").addEventListener("input", (event) => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6); });
    $("timer-toggle").addEventListener("click", () => void toggleTimer()); $("timer-reset").addEventListener("click", () => void resetTimer());
    $("result-a").addEventListener("click", () => stageResult("a")); $("result-b").addEventListener("click", () => stageResult("b")); $("result-draw").addEventListener("click", () => stageResult("draw"));
    $("add-team").addEventListener("click", openTeamDialog);
    $("team-form").addEventListener("submit", async (event) => { event.preventDefault(); const team = makeTeam($("team-name").value, $("team-rep").value, $("team-players").value.split("\n")); $("team-submit").disabled = true; try { if (isOwner) await addOwnerTeam(team); else await submitViewerTeam(team); $("team-dialog").close(); } catch (error) { showToast(errorMessage(error), false); } finally { $("team-submit").disabled = false; } });
    $("open-tools").addEventListener("click", openTools); $("edit-duration").addEventListener("click", openTools);
    document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => $(button.dataset.close).close()));
    $("settings-form").addEventListener("submit", async (event) => { event.preventDefault(); if (!isOwner || !canMutateEvent()) return; state.eventName = clean($("settings-name").value, 42) || "Hangar Night"; state.duration = Math.max(60, Math.min(3600, Math.round(Number($("settings-minutes").value) * 60))); state.running = false; state.endAt = null; state.remaining = state.duration; releaseWakeLock(); render(); await syncState(); showToast("Event settings saved", false); });
    $("copy-code").addEventListener("click", () => copyText(eventRecord.code, "Join code copied")); $("copy-live-link").addEventListener("click", () => copyText(eventLink(), "Live event link copied")); $("copy-join-code").addEventListener("click", () => copyText(eventRecord.code, "Join code copied"));
    $("leave-event").addEventListener("click", () => { $("tools-dialog").close(); leaveEvent(); }); $("delete-event").addEventListener("click", () => { $("tools-dialog").close(); stageDeleteEvent(); });
    $("cancel-confirm").addEventListener("click", () => void cancelPending()); $("confirm-dialog").addEventListener("cancel", (event) => { event.preventDefault(); void cancelPending(); });
    $("toast-action").addEventListener("click", async () => { if (!undoState || !isOwner || !canMutateEvent()) return; state = undoState; undoState = null; $("toast").classList.remove("show"); render(); await syncState(); announce("Last change undone."); });
    document.addEventListener("click", (event) => { const remove = event.target.closest("[data-remove]"); if (remove) stageRemove(remove.dataset.remove); const move = event.target.closest("[data-move]"); if (move) void moveTeam(move.dataset.id, move.dataset.move); const approve = event.target.closest("[data-approve]"); if (approve) void approveSubmission(approve.dataset.approve); const reject = event.target.closest("[data-reject]"); if (reject) void rejectSubmission(reject.dataset.reject); });
    document.addEventListener("visibilitychange", updateTimerView);
    $("create-tab").parentElement.addEventListener("keydown", (event) => { const tabs = [$("create-tab"), $("join-tab")], index = tabs.indexOf(document.activeElement); if (index < 0) return; if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : event.key === "ArrowRight" ? (index + 1) % 2 : (index + 1) % 2; tabs[next].focus(); tabs[next].click(); } });
  }
  function selectLandingTab(tab) { const create = tab === "create"; $("create-event-form").hidden = !create; $("join-event-form").hidden = create; $("create-tab").classList.toggle("active", create); $("join-tab").classList.toggle("active", !create); $("create-tab").setAttribute("aria-selected", String(create)); $("join-tab").setAttribute("aria-selected", String(!create)); }
  function openTeamDialog() { $("team-form").reset(); $("team-dialog-eyebrow").textContent = isOwner ? "NEW ENTRY" : "TEAM REQUEST"; $("team-dialog-title").textContent = isOwner ? "Add a team" : "Submit your team"; $("team-submit").textContent = isOwner ? "Add to rotation" : "Send for approval"; $("team-dialog").showModal(); setTimeout(() => $("team-name").focus(), 50); }
  function openTools() { if (!eventRecord) return; $("settings-name").value = state.eventName; $("settings-minutes").value = state.duration / 60; document.querySelectorAll("#tools-dialog .owner-only").forEach((element) => { element.hidden = !isOwner; }); $("tools-dialog").showModal(); }

  function registerWebMCP() {
    const context = document.modelContext; if (!context?.registerTool) return; const register = (tool) => Promise.resolve(context.registerTool(tool)).catch(() => {});
    register({ name: "get_live_event_status", title: "Get live event status", description: "Read the current live teams, timer, overtime, and rotation order.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: false }, execute: () => { if (!eventRecord) throw new Error("No live event is open."); const values = timerValues(); return { eventName: state.eventName, code: eventRecord.code, timerSeconds: values.remaining, overtimeSeconds: values.overtime, running: state.running, active: state.active.map(getTeam).map((team) => team?.name), next: state.queue.slice(0, 2).map(getTeam).map((team) => team?.name), queue: state.queue.map(getTeam).map((team) => team?.name) }; } });
    register({ name: "submit_team", title: "Submit team", description: "Add a team directly when organizing, or send it to the organizer for approval when watching.", inputSchema: { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 36 }, representative: { type: "string", minLength: 1, maxLength: 36 }, players: { type: "array", items: { type: "string", maxLength: 36 }, maxItems: 20 } }, required: ["name", "representative"], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: true }, execute: async (input) => { if (!eventRecord) throw new Error("No live event is open."); const team = makeTeam(input.name, input.representative, input.players || []); if (isOwner) await addOwnerTeam(team); else await submitViewerTeam(team); return { status: isOwner ? "added" : "pending_approval", team: team.name }; } });
    register({ name: "stage_match_result", title: "Stage match result", description: "For the organizer, open the visible slide confirmation for a loss or draw.", inputSchema: { type: "object", properties: { result: { type: "string", enum: ["team_a_lost", "team_b_lost", "draw"] } }, required: ["result"], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: (input) => { if (!isOwner) throw new Error("Only the organizer can finish a game."); const map = { team_a_lost: "a", team_b_lost: "b", draw: "draw" }; stageResult(map[input.result]); return { confirmationOpened: true }; } });
  }

  startTimerLoop(); void initialize();
})();
