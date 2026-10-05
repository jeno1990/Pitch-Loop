(() => {
  "use strict";
  const STORAGE_KEY = "pitchloop.event.v1";
  const MAX_TEAMS = 32;
  const palette = ["cyan", "orange", "lime", "violet", "blue", "rose", "gold", "mint"];
  const $ = (id) => document.getElementById(id);
  const uid = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const clean = (value, max = 36) => String(value || "").trim().slice(0, max);
  const makeTeam = (name, rep, players = []) => ({ id: uid(), name: clean(name), rep: clean(rep), players: players.map((p) => clean(p)).filter(Boolean).slice(0, 20), color: palette[Math.floor(Math.random() * palette.length)] });
  function normalizeTeam(raw) {
    if (!raw || typeof raw !== "object") return null;
    const name = clean(raw.name), rep = clean(raw.rep), id = clean(raw.id, 80) || uid();
    if (!name || !rep) return null;
    return { id, name, rep, players: Array.isArray(raw.players) ? raw.players.map((p) => clean(p)).filter(Boolean).slice(0, 20) : [], color: palette.includes(raw.color) ? raw.color : palette[Math.floor(Math.random() * palette.length)] };
  }
  const demoTeams = [makeTeam("Storm Hawks", "Alex", ["Alex", "Maya", "Ben", "Ibrahim", "Noah"]), makeTeam("Red Tigers", "Sam", ["Sam", "Nina", "Omar", "Zoe", "Kai"]), makeTeam("Falcon Crew", "Jordan"), makeTeam("Blue Kings", "Chris"), makeTeam("United Five", "Mo"), makeTeam("Night City", "Lee")];
  const freshState = () => ({ version: 1, eventName: "Sunday Hangar", duration: 420, remaining: 420, endAt: null, running: false, game: 1, teams: demoTeams, active: demoTeams.slice(0, 2).map((t) => t.id), queue: demoTeams.slice(2).map((t) => t.id) });
  let state = loadState();
  let timerHandle = null;
  let pendingAction = null;
  let undoState = null;
  let toastTimer = null;
  let wakeLock = null;

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!saved || saved.version !== 1 || !Array.isArray(saved.teams) || !Array.isArray(saved.active) || !Array.isArray(saved.queue)) return freshState();
      saved.teams = saved.teams.map(normalizeTeam).filter(Boolean).filter((team, index, all) => all.findIndex((item) => item.id === team.id) === index).slice(0, MAX_TEAMS);
      const ids = new Set(saved.teams.map((t) => t.id));
      const seenRotation = new Set();
      saved.active = saved.active.filter((id) => ids.has(id) && !seenRotation.has(id) && seenRotation.add(id)).slice(0, 2);
      saved.queue = saved.queue.filter((id) => ids.has(id) && !seenRotation.has(id) && seenRotation.add(id));
      saved.teams.forEach((team) => { if (!seenRotation.has(team.id)) { saved.queue.push(team.id); seenRotation.add(team.id); } });
      saved.duration = Math.max(60, Math.min(3600, Number(saved.duration) || 420));
      const parsedRemaining = Number(saved.remaining);
      saved.remaining = Number.isFinite(parsedRemaining) ? Math.max(0, Math.min(saved.duration, parsedRemaining)) : saved.duration;
      saved.eventName = clean(saved.eventName, 42) || "Hangar Night";
      saved.game = Math.max(1, Math.floor(Number(saved.game) || 1));
      if (saved.running && saved.endAt) saved.remaining = Math.max(0, Math.ceil((saved.endAt - Date.now()) / 1000));
      if (saved.remaining === 0) { saved.running = false; saved.endAt = null; }
      return saved;
    } catch { return freshState(); }
  }
  function saveState() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { announce("This browser could not save the event. Keep this page open."); } }
  const getTeam = (id) => state.teams.find((team) => team.id === id);
  const initials = (name) => clean(name).split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "FC";
  function escapeText(value) { const node = document.createElement("span"); node.textContent = value; return node.innerHTML; }
  function escapeAttr(value) { return escapeText(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
  function announce(message) { $("announcer").textContent = ""; requestAnimationFrame(() => { $("announcer").textContent = message; }); }

  function render() {
    $("event-title").textContent = state.eventName;
    $("duration-label").textContent = Math.round(state.duration / 60);
    $("game-label").textContent = `Game ${String(state.game).padStart(2, "0")}`;
    const activeTeams = state.active.map(getTeam).filter(Boolean);
    $("matchup").innerHTML = [0, 1].map((slot) => teamCard(activeTeams[slot], slot)).join('<div class="versus" aria-hidden="true">VS</div>');
    const canPlay = activeTeams.length === 2;
    $("result-a").textContent = activeTeams[0] ? `${activeTeams[0].name} lost` : "Team A lost";
    $("result-b").textContent = activeTeams[1] ? `${activeTeams[1].name} lost` : "Team B lost";
    [$("result-a"), $("result-b"), $("result-draw")].forEach((button) => { button.disabled = !canPlay; });
    $("timer-toggle").disabled = !canPlay || state.remaining === 0;
    const nextIds = state.queue.slice(0, 2);
    $("next-grid").innerHTML = [0, 1].map((index) => nextCard(getTeam(nextIds[index]), index)).join("");
    $("queue-count").textContent = `${state.queue.length} waiting`;
    const later = state.queue.slice(2);
    $("queue-list").innerHTML = later.length ? later.map((id, i) => queueRow(getTeam(id), i + 3, i + 2)).join("") : '<p class="queue-empty">The next two teams are the full queue.</p>';
    updateTimerView(); saveState();
  }
  function teamCard(team, slot) {
    if (!team) return `<article class="team-card empty-card"><span class="team-status">ON PITCH · ${slot ? "B" : "A"}</span><div class="empty-team">Waiting for a team</div></article>`;
    const count = team.players.length ? `${team.players.length} players` : "Representative";
    return `<article class="team-card team-${slot ? "b" : "a"}"><button class="mini-remove" data-remove="${escapeAttr(team.id)}" aria-label="Remove ${escapeAttr(team.name)}">×</button><span class="team-status">ON PITCH · ${slot ? "B" : "A"}</span><div class="kit-badge ${team.color}">${initials(team.name)}</div><h3>${escapeText(team.name)}</h3><p>${escapeText(team.rep)} · ${count}</p></article>`;
  }
  function nextCard(team, index) {
    if (!team) return `<article class="next-card empty-next"><span>NEXT ${index + 1}</span><div class="queue-avatar">—</div><strong>Waiting for a team</strong><small>Add another side</small></article>`;
    return `<article class="next-card"><button class="mini-remove" data-remove="${escapeAttr(team.id)}" aria-label="Remove ${escapeAttr(team.name)}">×</button><span>NEXT ${index + 1}</span><div class="queue-avatar ${team.color}">${initials(team.name)}</div><strong>${escapeText(team.name)}</strong><small>${escapeText(team.rep)}</small></article>`;
  }
  function queueRow(team, position, queueIndex) {
    if (!team) return "";
    return `<div class="queue-row"><span class="position">${position}</span><div class="queue-avatar small ${team.color}">${initials(team.name)}</div><div><strong>${escapeText(team.name)}</strong><small>${escapeText(team.rep)}</small></div><div class="queue-actions"><button data-move="up" data-id="${escapeAttr(team.id)}" aria-label="Move ${escapeAttr(team.name)} up">↑</button><button data-move="down" data-id="${escapeAttr(team.id)}" aria-label="Move ${escapeAttr(team.name)} down" ${queueIndex === state.queue.length - 1 ? "disabled" : ""}>↓</button><button data-remove="${escapeAttr(team.id)}" aria-label="Remove ${escapeAttr(team.name)}">×</button></div></div>`;
  }

  function updateTimerView() {
    if (state.running && state.endAt) { state.remaining = Math.max(0, Math.ceil((state.endAt - Date.now()) / 1000)); if (state.remaining === 0) timerExpired(); }
    const minutes = Math.floor(state.remaining / 60); const seconds = state.remaining % 60;
    $("timer").textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    $("timer").classList.toggle("final-minute", state.remaining > 0 && state.remaining <= 60);
    $("timer").setAttribute("aria-label", state.remaining ? `${minutes} minutes ${seconds} seconds remaining` : "Time is up");
    $("timer-toggle").querySelector("span").textContent = state.running ? "Pause match" : state.remaining === 0 ? "Time up" : state.remaining < state.duration ? "Resume match" : "Start match";
    $("match-status").innerHTML = state.remaining === 0 ? '<span class="danger-dot"></span> Time up' : state.running ? '<span></span> Match live' : '<span></span> Match ready';
  }
  async function toggleTimer() {
    if (state.active.length < 2 || state.remaining === 0) return;
    if (state.running) pauseTimer(); else { state.running = true; state.endAt = Date.now() + state.remaining * 1000; timerHandle = window.setInterval(tick, 250); try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {} }
    updateTimerView(); saveState();
  }
  function pauseTimer() { if (state.running && state.endAt) state.remaining = Math.max(0, Math.ceil((state.endAt - Date.now()) / 1000)); state.running = false; state.endAt = null; clearInterval(timerHandle); timerHandle = null; wakeLock?.release?.(); wakeLock = null; }
  function resetTimer() { pauseTimer(); state.remaining = state.duration; updateTimerView(); saveState(); }
  function tick() { updateTimerView(); if (state.remaining % 5 === 0) saveState(); }
  function timerExpired() { pauseTimer(); state.remaining = 0; navigator.vibrate?.([160, 80, 160]); announce("Time is up. Choose the match result."); saveState(); }

  function stageResult(type) {
    if (state.active.length < 2) return;
    const a = getTeam(state.active[0]), b = getTeam(state.active[1]); const incoming = state.queue.slice(0, type === "draw" ? 2 : 1).map(getTeam).filter(Boolean);
    pendingAction = { kind: "result", type, wasRunning: state.running }; pauseTimer();
    $("confirm-eyebrow").textContent = "CONFIRM RESULT"; $("confirm-title").textContent = type === "draw" ? "Confirm a draw" : `${type === "a" ? a.name : b.name} lost?`;
    $("confirm-description").textContent = type === "draw" ? "Both teams rotate out. Their order at the back will be randomized." : `${type === "a" ? b.name : a.name} stays on the pitch.`;
    $("rotation-preview").innerHTML = `<span>OUT<br><strong>${escapeText(type === "draw" ? `${a.name} + ${b.name}` : (type === "a" ? a.name : b.name))}</strong></span><b>→</b><span>IN<br><strong>${escapeText(incoming.length ? incoming.map((t) => t.name).join(" + ") : "No waiting team")}</strong></span>`;
    $("slide-label").textContent = incoming.length || type === "draw" ? "Slide to rotate" : "Slide to record result"; $("confirm-action").textContent = "Confirm rotation"; $("slide-control").hidden = false; resetSlider(); $("confirm-dialog").showModal();
  }
  function applyResult(type) {
    if (!state.active.length) return; undoState = structuredClone(state);
    if (type === "a" || type === "b") { const slot = type === "a" ? 0 : 1; const loser = state.active[slot]; if (state.queue.length) { state.active[slot] = state.queue.shift(); state.queue.push(loser); } }
    else { const outgoing = [...state.active]; if (Math.random() < .5) outgoing.reverse(); const pool = [...state.queue, ...outgoing]; state.active = pool.splice(0, 2); state.queue = pool; }
    state.game += 1; resetTimer(); render(); closeConfirm(); showToast("Rotation updated", true); announce("Rotation updated. New teams are on the pitch.");
  }
  function stageRemove(id) {
    const team = getTeam(id); if (!team) return; pendingAction = { kind: "remove", id };
    $("confirm-eyebrow").textContent = "REMOVE TEAM"; $("confirm-title").textContent = `Remove ${team.name}?`; $("confirm-description").textContent = state.active.includes(id) ? "A waiting team will move into this pitch slot and the match timer will reset." : "This team will leave the event rotation.";
    $("rotation-preview").innerHTML = ""; $("slide-control").hidden = true; $("confirm-action").textContent = "Remove team"; $("confirm-dialog").showModal();
  }
  function removeTeam(id) {
    undoState = structuredClone(state); const activeIndex = state.active.indexOf(id); state.teams = state.teams.filter((team) => team.id !== id); state.queue = state.queue.filter((teamId) => teamId !== id);
    if (activeIndex >= 0) { state.active.splice(activeIndex, 1); if (state.queue.length) state.active.splice(activeIndex, 0, state.queue.shift()); resetTimer(); }
    render(); closeConfirm(); showToast("Team removed", true); announce("Team removed from the event.");
  }
  function addTeam(team) {
    if (state.teams.length >= MAX_TEAMS) throw new Error("This event already has the maximum of 32 teams.");
    if (state.teams.some((item) => item.name.toLocaleLowerCase() === team.name.toLocaleLowerCase())) throw new Error("A team with that name is already in this event.");
    state.teams.push(team); if (state.active.length < 2) state.active.push(team.id); else state.queue.push(team.id); render(); announce(`${team.name} added to the rotation.`); showToast(`${team.name} added`, false);
  }
  function moveTeam(id, direction) { const index = state.queue.indexOf(id); const next = direction === "up" ? index - 1 : index + 1; if (index < 0 || next < 0 || next >= state.queue.length) return; [state.queue[index], state.queue[next]] = [state.queue[next], state.queue[index]]; render(); }

  function checksum(text) { let hash = 2166136261; for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(36); }
  function encodePayload(payload) { const json = JSON.stringify(payload); const bytes = new TextEncoder().encode(json); let binary = ""; bytes.forEach((b) => { binary += String.fromCharCode(b); }); const body = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); return `PL1.${body}.${checksum(body)}`; }
  function decodePayload(code) {
    const trimmed = clean(code, 160000); const parts = trimmed.split("."); if (parts.length !== 3 || parts[0] !== "PL1" || checksum(parts[1]) !== parts[2]) throw new Error("That code is incomplete or has been changed.");
    const base = parts[1].replace(/-/g, "+").replace(/_/g, "/"); const binary = atob(base + "===".slice((base.length + 3) % 4)); const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0)); const payload = JSON.parse(new TextDecoder().decode(bytes));
    if (payload.v !== 1 || !["event", "team"].includes(payload.type)) throw new Error("This code version is not supported."); return payload;
  }
  function eventPayload() { return { v: 1, type: "event", name: state.eventName, duration: state.duration, teams: state.teams.map(({ id, name, rep, players, color }) => ({ id, name, rep, players, color })), active: state.active, queue: state.queue }; }
  function validateEventPayload(payload) {
    if (!Array.isArray(payload.teams) || !Array.isArray(payload.active) || !Array.isArray(payload.queue) || payload.teams.length > MAX_TEAMS || payload.active.length > 2) throw new Error("This event code contains an invalid team list.");
    const teams = payload.teams.map(normalizeTeam);
    if (teams.some((team) => !team) || new Set(teams.map((team) => team.id)).size !== teams.length) throw new Error("This event code contains invalid or duplicate teams.");
    const ids = new Set(teams.map((team) => team.id));
    const rotation = [...payload.active, ...payload.queue];
    if (rotation.some((id) => !ids.has(id)) || new Set(rotation).size !== rotation.length) throw new Error("This event code has an invalid rotation order.");
    return { ...payload, teams, active: payload.active.slice(0, 2), queue: payload.queue.filter((id) => !payload.active.slice(0, 2).includes(id)) };
  }
  async function copyText(text, success) {
    try { await navigator.clipboard.writeText(text); showToast(success, false); }
    catch { $("import-code").value = text; $("import-code").focus(); $("import-code").select(); showToast("Copy blocked — the code is selected below", false); }
  }
  function previewImport() {
    try {
      const payload = decodePayload($("import-code").value);
      if (payload.type === "team") { const raw = payload.team || {}; const team = makeTeam(clean(raw.name), clean(raw.rep), Array.isArray(raw.players) ? raw.players : []); if (!team.name || !team.rep) throw new Error("This team pass is missing required details."); pendingAction = { kind: "import-team", team }; $("confirm-eyebrow").textContent = "IMPORT TEAM"; $("confirm-title").textContent = `Add ${team.name}?`; $("confirm-description").textContent = `${team.rep} will represent this team.`; $("confirm-action").textContent = "Add team"; }
      else { const validated = validateEventPayload(payload); pendingAction = { kind: "import-event", payload: validated }; $("confirm-eyebrow").textContent = "IMPORT EVENT"; $("confirm-title").textContent = `Replace with ${clean(validated.name, 42) || "imported event"}?`; $("confirm-description").textContent = `This snapshot has ${validated.teams.length} teams. Your current event will be replaced.`; $("confirm-action").textContent = "Replace event"; }
      $("rotation-preview").innerHTML = ""; $("slide-control").hidden = true; $("confirm-dialog").showModal();
    } catch (error) { showToast(error.message || "That code could not be read.", false); }
  }
  function importEvent(payload) {
    const teams = payload.teams;
    const ids = new Set(teams.map((t) => t.id)); const active = (payload.active || []).filter((id) => ids.has(id)).slice(0, 2); const queue = (payload.queue || []).filter((id) => ids.has(id) && !active.includes(id)); teams.forEach((team) => { if (!active.includes(team.id) && !queue.includes(team.id)) queue.push(team.id); });
    const duration = Math.max(60, Math.min(3600, Number(payload.duration) || 420)); state = { version: 1, eventName: clean(payload.name, 42) || "Imported event", duration, remaining: duration, endAt: null, running: false, game: 1, teams, active, queue };
    while (state.active.length < 2 && state.queue.length) state.active.push(state.queue.shift()); closeConfirm(); $("tools-dialog").close(); render(); showToast("Event imported", false); announce("Event imported successfully.");
  }

  function showToast(message, undo = false) { clearTimeout(toastTimer); $("toast-message").textContent = message; $("toast-action").hidden = !undo; $("toast").classList.add("show"); toastTimer = setTimeout(() => $("toast").classList.remove("show"), undo ? 8000 : 3200); }
  function closeConfirm() { if ($("confirm-dialog").open) $("confirm-dialog").close(); pendingAction = null; resetSlider(); }
  function cancelConfirm() { const resume = pendingAction?.kind === "result" && pendingAction.wasRunning && state.remaining > 0; closeConfirm(); if (resume) void toggleTimer(); }
  function commitPending() {
    if (!pendingAction) return; const action = pendingAction;
    if (action.kind === "result") applyResult(action.type); else if (action.kind === "remove") removeTeam(action.id);
    else if (action.kind === "import-team") { try { addTeam(action.team); closeConfirm(); $("import-code").value = ""; } catch (error) { closeConfirm(); showToast(error.message, false); } }
    else if (action.kind === "import-event") importEvent(action.payload);
    else if (action.kind === "new-event") { localStorage.removeItem(STORAGE_KEY); state = { ...freshState(), eventName: "New Hangar Night", teams: [], active: [], queue: [] }; closeConfirm(); $("tools-dialog").close(); render(); }
  }

  const slider = $("slide-control"), knob = $("slide-knob"), fill = $("slide-fill"); let dragStart = 0, dragging = false;
  function resetSlider() { knob.style.transform = "translateX(0)"; fill.style.width = "0"; dragging = false; }
  knob.addEventListener("pointerdown", (event) => { dragging = true; dragStart = event.clientX; knob.setPointerCapture(event.pointerId); });
  knob.addEventListener("pointermove", (event) => { if (!dragging) return; const max = slider.clientWidth - knob.offsetWidth - 8; const x = Math.max(0, Math.min(max, event.clientX - dragStart)); knob.style.transform = `translateX(${x}px)`; fill.style.width = `${x + knob.offsetWidth}px`; });
  knob.addEventListener("pointerup", (event) => { if (!dragging) return; dragging = false; const max = slider.clientWidth - knob.offsetWidth - 8; const x = Math.max(0, event.clientX - dragStart); if (x >= max * .82) commitPending(); else resetSlider(); });

  $("timer-toggle").addEventListener("click", toggleTimer); $("timer-reset").addEventListener("click", resetTimer); $("result-a").addEventListener("click", () => stageResult("a")); $("result-b").addEventListener("click", () => stageResult("b")); $("result-draw").addEventListener("click", () => stageResult("draw"));
  $("add-team").addEventListener("click", () => { $("team-form").reset(); $("team-dialog").showModal(); setTimeout(() => $("team-name").focus(), 50); });
  $("team-form").addEventListener("submit", (event) => { event.preventDefault(); try { addTeam(makeTeam($("team-name").value, $("team-rep").value, $("team-players").value.split("\n"))); $("team-dialog").close(); } catch (error) { showToast(error.message, false); } });
  $("open-tools").addEventListener("click", () => { $("settings-name").value = state.eventName; $("settings-minutes").value = state.duration / 60; $("tools-dialog").showModal(); }); $("edit-duration").addEventListener("click", () => $("open-tools").click());
  document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => $(button.dataset.close).close()));
  $("settings-form").addEventListener("submit", (event) => { event.preventDefault(); state.eventName = clean($("settings-name").value, 42) || "Hangar Night"; state.duration = Math.max(60, Math.min(3600, Math.round(Number($("settings-minutes").value) * 60))); resetTimer(); render(); showToast("Event settings saved", false); });
  $("copy-event-code").addEventListener("click", () => copyText(encodePayload(eventPayload()), "Event code copied"));
  $("copy-team-code").addEventListener("click", () => { const team = makeTeam($("pass-name").value, $("pass-rep").value); if (!team.name || !team.rep) return showToast("Add a team name and representative first.", false); copyText(encodePayload({ v: 1, type: "team", team }), "Team pass copied"); });
  $("import-button").addEventListener("click", previewImport);
  $("new-event").addEventListener("click", () => { pendingAction = { kind: "new-event" }; $("confirm-eyebrow").textContent = "START OVER"; $("confirm-title").textContent = "Start a new event?"; $("confirm-description").textContent = "This clears the current teams and match state from this device."; $("rotation-preview").innerHTML = ""; $("slide-control").hidden = true; $("confirm-action").textContent = "Clear current event"; $("confirm-dialog").showModal(); });
  $("confirm-action").addEventListener("click", commitPending); $("cancel-confirm").addEventListener("click", cancelConfirm); $("confirm-dialog").addEventListener("cancel", (event) => { event.preventDefault(); cancelConfirm(); });
  $("toast-action").addEventListener("click", () => {
    if (!undoState) return; clearInterval(timerHandle); timerHandle = null; state = undoState; undoState = null;
    if (state.running && state.endAt > Date.now()) timerHandle = window.setInterval(tick, 250); else if (state.running) { state.running = false; state.endAt = null; state.remaining = 0; }
    $("toast").classList.remove("show"); render(); announce("Last change undone.");
  });
  document.addEventListener("click", (event) => { const remove = event.target.closest("[data-remove]"); if (remove) stageRemove(remove.dataset.remove); const move = event.target.closest("[data-move]"); if (move) moveTeam(move.dataset.id, move.dataset.move); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) updateTimerView(); });

  function registerWebMCP() {
    const context = document.modelContext; if (!context?.registerTool) return; const register = (tool) => Promise.resolve(context.registerTool(tool)).catch(() => {});
    register({ name: "get_event_status", title: "Get event status", description: "Read the current teams, timer, and rotation order without changing the event.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: false }, execute: () => ({ eventName: state.eventName, timerSeconds: state.remaining, running: state.running, active: state.active.map(getTeam).map((t) => t?.name), next: state.queue.slice(0, 2).map(getTeam).map((t) => t?.name), queue: state.queue.map(getTeam).map((t) => t?.name) }) });
    register({ name: "add_team", title: "Add team", description: "Add one team to the current event rotation.", inputSchema: { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 36 }, representative: { type: "string", minLength: 1, maxLength: 36 }, players: { type: "array", items: { type: "string", maxLength: 36 }, maxItems: 20 } }, required: ["name", "representative"], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: true }, execute: (input) => { const team = makeTeam(input?.name, input?.representative, Array.isArray(input?.players) ? input.players : []); if (!team.name || !team.rep) throw new Error("Team name and representative are required."); addTeam(team); return { added: team.name, waitingTeams: state.queue.length }; } });
    register({ name: "stage_match_result", title: "Stage match result", description: "Open the visible confirmation for a Team A loss, Team B loss, or draw. The organizer must still confirm it.", inputSchema: { type: "object", properties: { result: { type: "string", enum: ["team_a_lost", "team_b_lost", "draw"] } }, required: ["result"], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: (input) => { const map = { team_a_lost: "a", team_b_lost: "b", draw: "draw" }; if (!map[input?.result]) throw new Error("Unsupported result."); stageResult(map[input.result]); return { confirmationOpened: true, result: input.result }; } });
  }
  if (state.running) timerHandle = window.setInterval(tick, 250); render(); registerWebMCP();
})();
