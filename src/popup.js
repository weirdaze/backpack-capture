const STATUS_LABEL = {
  ok: "ok",
  low_confidence: "low confidence",
  adapter_may_be_broken: "layout changed?",
  login_wall: "login wall",
};

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtClock(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function pages(n) {
  return `${n} page${n === 1 ? "" : "s"}`;
}

function titleFor(envelope) {
  try {
    const u = new URL(envelope.source_url);
    return u.pathname.replace(/\/+$/, "") || u.hostname;
  } catch {
    return envelope.source_url;
  }
}

function setStatus(text) {
  const el = document.getElementById("status");
  el.textContent = text;
  el.hidden = !text;
}

function setSchoolzStatus(text) {
  const el = document.getElementById("schoolzStatus");
  el.textContent = text;
  el.hidden = !text;
}

async function renderSchoolz() {
  const state = await chrome.runtime.sendMessage({ type: "SCHOOLZ_GET_STATE" });
  const loginForm = document.getElementById("schoolzLoginForm");
  const publishForm = document.getElementById("schoolzPublishForm");

  if (!state || !state.loggedIn) {
    loginForm.hidden = false;
    publishForm.hidden = true;
    return;
  }

  loginForm.hidden = true;
  publishForm.hidden = false;
  document.getElementById("schoolzEmailLabel").textContent = state.email;

  const select = document.getElementById("schoolzStudentSelect");
  const previousValue = select.value;
  select.innerHTML = "";
  for (const student of state.students || []) {
    const option = document.createElement("option");
    option.value = student.id;
    option.textContent = `${student.first_name} ${student.last_name}`;
    select.appendChild(option);
  }
  if (previousValue && [...select.options].some((o) => o.value === previousValue)) {
    select.value = previousValue;
  }
  document.getElementById("schoolzPublishBtn").disabled = !select.options.length;
  if (!select.options.length) {
    setSchoolzStatus("No students on your schoolz account yet — add one at schoolz.sitenaut.com first.");
  }
}

document.getElementById("schoolzLoginBtn").addEventListener("click", async () => {
  const email = document.getElementById("schoolzEmail").value.trim();
  const password = document.getElementById("schoolzPassword").value;
  if (!email || !password) {
    setSchoolzStatus("Enter your email and password.");
    return;
  }
  setSchoolzStatus("Logging in…");
  const result = await chrome.runtime.sendMessage({ type: "SCHOOLZ_LOGIN", email, password });
  if (!result || !result.ok) {
    setSchoolzStatus(`Login failed: ${(result && result.error) || "unknown error"}`);
    return;
  }
  document.getElementById("schoolzPassword").value = "";
  setSchoolzStatus("");
  renderSchoolz();
});

document.getElementById("schoolzGoogleBtn").addEventListener("click", async () => {
  setSchoolzStatus("Continue in the Google sign-in window…");
  const result = await chrome.runtime.sendMessage({ type: "SCHOOLZ_LOGIN_GOOGLE" });
  if (!result || !result.ok) {
    setSchoolzStatus(`Google sign-in failed: ${(result && result.error) || "unknown error"}`);
    return;
  }
  setSchoolzStatus("");
  renderSchoolz();
});

document.getElementById("schoolzLogoutBtn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "SCHOOLZ_LOGOUT" });
  setSchoolzStatus("");
  renderSchoolz();
});

document.getElementById("schoolzPublishBtn").addEventListener("click", async () => {
  const studentId = document.getElementById("schoolzStudentSelect").value;
  if (!studentId) return;
  const btn = document.getElementById("schoolzPublishBtn");
  btn.disabled = true;
  setSchoolzStatus("Publishing…");
  const response = await chrome.runtime.sendMessage({ type: "SCHOOLZ_PUBLISH", studentId });
  btn.disabled = false;
  if (!response || !response.ok) {
    setSchoolzStatus(`Publish failed: ${(response && response.error) || "unknown error"}`);
    return;
  }
  const r = response.result;
  setSchoolzStatus(
    `Published: ${pages(r.captures_processed)} imported${
      r.captures_skipped_duplicate ? `, ${r.captures_skipped_duplicate} already had this` : ""
    }.`
  );
});

let currentSession = { active: false, startedAt: null, count: 0, pages: [] };

// Following assignment/material links and walking every class from the
// homepage are always on for an active session now (no longer a per-session
// checkbox) - Export and Publish staying one-click, user-triggered actions
// is what keeps this safe: the person always sees and controls exactly
// what was captured before anything leaves the device.
async function renderSession() {
  const { session } = await chrome.runtime.sendMessage({ type: "GET_SESSION" });
  currentSession = session;
  const card = document.getElementById("session");
  const title = document.getElementById("sessionTitle");
  const detail = document.getElementById("sessionDetail");
  const toggle = document.getElementById("sessionToggle");
  const save = document.getElementById("saveTemplate");

  card.classList.toggle("active", session.active);
  if (session.active) {
    title.textContent = session.replaying ? `Replaying ${session.replaying}` : "Capturing";
    detail.textContent = `Since ${fmtClock(session.startedAt)} · ${pages(
      session.count
    )} saved. Just browse — assignment pages and every class open on their own.`;
    toggle.textContent = "End capture";
    toggle.className = "stop";
  } else {
    title.textContent = "Not capturing";
    detail.textContent = session.startedAt
      ? `Last session saved ${pages(session.count)}.`
      : "Press Start, then open your child's Classroom and Genesis pages.";
    toggle.textContent = "Start capture";
    toggle.className = "primary";
  }
  save.hidden = session.active || !(session.pages || []).length;
}

async function renderTemplates() {
  const { templates, replay } = await chrome.runtime.sendMessage({ type: "GET_TEMPLATES" });
  const section = document.getElementById("templatesSection");
  const list = document.getElementById("templateList");
  section.hidden = !(templates || []).length;
  list.innerHTML = "";

  for (const template of templates || []) {
    const li = document.createElement("li");

    const info = document.createElement("div");
    info.className = "template-info";
    const name = document.createElement("strong");
    name.textContent = template.name;
    const meta = document.createElement("div");
    meta.className = "muted";
    const steps = window.BackpackTemplates.pageCount(template.steps);
    meta.textContent = template.lastReplayedAt
      ? `${pages(steps)} · last replayed ${fmtTime(template.lastReplayedAt)}`
      : `${pages(steps)} · never replayed`;
    info.append(name, meta);

    const replayBtn = document.createElement("button");
    replayBtn.textContent = "Replay";
    replayBtn.disabled = Boolean(replay && replay.active);
    replayBtn.addEventListener("click", async () => {
      const result = await chrome.runtime.sendMessage({ type: "START_REPLAY", id: template.id });
      setStatus(result && result.ok ? "" : "Couldn't start replay.");
      renderReplay();
      renderTemplates();
    });

    const del = document.createElement("button");
    del.className = "icon";
    del.title = `Delete ${template.name}`;
    del.textContent = "✕";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete the template "${template.name}"? Saved pages aren't affected.`)) return;
      await chrome.runtime.sendMessage({ type: "DELETE_TEMPLATE", id: template.id });
      renderTemplates();
    });

    li.append(info, replayBtn, del);
    list.appendChild(li);
  }
}

async function renderReplay() {
  const { replay } = await chrome.runtime.sendMessage({ type: "GET_TEMPLATES" });
  const card = document.getElementById("replay");
  if (!replay) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const title = document.getElementById("replayTitle");
  const detail = document.getElementById("replayDetail");
  const cancel = document.getElementById("replayCancel");

  if (replay.active) {
    title.textContent = `Replaying ${replay.name}`;
    detail.textContent =
      replay.kind === "prompt"
        ? `Step ${replay.index + 1} of ${replay.total} — waiting for you on the page.`
        : `Step ${replay.index + 1} of ${replay.total}…`;
    cancel.hidden = false;
  } else {
    title.textContent = replay.cancelled ? "Replay stopped" : "Replay finished";
    detail.textContent = `${pages(replay.captured)} captured${replay.skipped ? `, ${replay.skipped} skipped` : ""}.`;
    cancel.hidden = true;
  }
}

const CRAWL_PROGRESS_KEY = "backpack_crawl_progress";

// Read directly from storage (background.js writes it there), same as the
// opt-in checkbox prefs - there's nothing here a round-trip message would
// add. Stays visible after a walk finishes, showing its final tally, until
// the next one starts and resets it.
async function renderCrawlProgress() {
  const data = await chrome.storage.local.get(CRAWL_PROGRESS_KEY);
  const progress = data[CRAWL_PROGRESS_KEY];
  const section = document.getElementById("crawlProgress");
  if (!progress) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  document.getElementById("crawlProgressTitle").textContent = progress.active
    ? "Walking classes…"
    : progress.aborted
    ? "Walk stopped early — repeated broken pages"
    : "Walk finished";

  const courseRow = document.getElementById("crawlCourseRow");
  const isCourseWalk = progress.kind === "course";
  courseRow.hidden = !isCourseWalk;
  if (isCourseWalk) {
    const courseBar = document.getElementById("crawlCourseBar");
    courseBar.max = Math.max(progress.courseTotal, 1);
    courseBar.value = progress.courseIndex;
    document.getElementById("crawlCourseLabel").textContent = progress.currentCourseTitle
      ? `Class ${progress.courseIndex} of ${progress.courseTotal}: ${progress.currentCourseTitle}`
      : `Class ${progress.courseIndex} of ${progress.courseTotal}`;
  }

  const itemsDone = progress.itemsCaptured + progress.itemsSkipped;
  const itemsBar = document.getElementById("crawlItemsBar");
  itemsBar.max = Math.max(progress.itemsQueuedTotal, 1);
  itemsBar.value = itemsDone;
  const stillFinding = progress.active && progress.itemsQueuedTotal > itemsDone;
  document.getElementById("crawlItemsLabel").textContent = `${pages(progress.itemsCaptured)} captured${
    progress.itemsSkipped ? `, ${progress.itemsSkipped} skipped` : ""
  }${stillFinding ? ` (${progress.itemsQueuedTotal} found so far)` : ""}`;
}

function renderSites() {
  const list = document.getElementById("siteList");
  list.innerHTML = "";
  for (const site of window.BackpackSites.SUPPORTED_SITES) {
    const li = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = site.name;
    const where = document.createElement("span");
    where.className = "muted";
    where.textContent = site.where;
    li.append(name, where);
    list.appendChild(li);
  }
}

async function renderTabNote() {
  let site = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    site = tab ? window.BackpackSites.supportedSite(tab.url) : null;
  } catch {
    site = null;
  }
  const note = document.getElementById("tabNote");
  note.hidden = false;
  note.className = site ? "tab-note ok" : "tab-note off";
  note.textContent = site
    ? `This tab is ${site.name}, so it can be captured.`
    : "This tab isn't Google Classroom or Genesis, so the extension can't read it.";
  document.getElementById("captureNow").disabled = !site;
}

async function renderCaptures() {
  const { captures } = await chrome.runtime.sendMessage({ type: "GET_CAPTURES" });
  const list = document.getElementById("captureList");
  const empty = document.getElementById("emptyState");
  list.innerHTML = "";
  document.getElementById("captureCount").textContent = String((captures || []).length);

  if (!captures || !captures.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  for (const envelope of captures) {
    const li = document.createElement("li");
    li.className = "capture-row";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = titleFor(envelope);
    li.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "meta";

    const badge = document.createElement("span");
    badge.className = `badge ${envelope.status}`;
    badge.textContent = STATUS_LABEL[envelope.status] || envelope.status;
    meta.appendChild(badge);

    const time = document.createElement("span");
    time.textContent = fmtTime(envelope.captured_at);
    meta.appendChild(time);

    const chars = document.createElement("span");
    chars.textContent = `${envelope.char_count.toLocaleString()} chars`;
    meta.appendChild(chars);

    if (envelope.account_index !== null && envelope.account_index !== undefined) {
      const acct = document.createElement("span");
      acct.textContent = `account /u/${envelope.account_index}/`;
      meta.appendChild(acct);
    }

    li.appendChild(meta);

    const rowActions = document.createElement("div");
    rowActions.className = "row-actions";
    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "DELETE_CAPTURE", id: envelope.id });
      renderCaptures();
    });
    rowActions.appendChild(delBtn);
    li.appendChild(rowActions);

    list.appendChild(li);
  }
}

document.getElementById("sessionToggle").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: currentSession.active ? "END_SESSION" : "START_SESSION" });
  renderSession();
});

document.getElementById("saveTemplate").addEventListener("click", async () => {
  const suggested = window.BackpackTemplates.defaultName(new Date());
  const name = prompt("Name this template", suggested);
  if (name === null) return;
  const result = await chrome.runtime.sendMessage({ type: "SAVE_TEMPLATE", name });
  setStatus(result && result.ok ? "Template saved." : "That session had no pages to save.");
  renderTemplates();
});

document.getElementById("replayCancel").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CANCEL_REPLAY" });
  renderReplay();
});

document.getElementById("captureNow").addEventListener("click", async () => {
  setStatus("Capturing…");
  const result = await chrome.runtime.sendMessage({ type: "TRIGGER_MANUAL_CAPTURE" });
  if (result && result.ok) {
    setStatus("");
  } else {
    setStatus(
      result && result.error === "unsupported_tab"
        ? "Open a Google Classroom or Genesis tab first."
        : "Capture failed — reload the tab and try again."
    );
  }
});

document.getElementById("exportCapture").addEventListener("click", async () => {
  setStatus("Exporting…");
  const result = await chrome.runtime.sendMessage({ type: "EXPORT_CAPTURES" });
  setStatus(result && result.ok ? "Exported." : "Export failed.");
});

document.getElementById("clearAll").addEventListener("click", async () => {
  if (!confirm("Delete all saved pages? Templates are kept. This can't be undone.")) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_CAPTURES" });
  renderCaptures();
});

// Captures and replay steps land while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.backpack_session) renderSession();
  if (changes.backpack_captures) renderCaptures();
  if (changes.backpack_templates) renderTemplates();
  if (changes.backpack_replay) {
    renderReplay();
    renderTemplates();
  }
  if (changes.backpack_crawl_progress) renderCrawlProgress();
});

renderSites();
renderTabNote();
renderSession();
renderTemplates();
renderReplay();
renderCrawlProgress();
renderCaptures();
renderSchoolz();
