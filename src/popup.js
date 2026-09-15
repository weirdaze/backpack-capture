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

let currentSession = { active: false, startedAt: null, count: 0 };

async function renderSession() {
  const { session } = await chrome.runtime.sendMessage({ type: "GET_SESSION" });
  currentSession = session;
  const card = document.getElementById("session");
  const title = document.getElementById("sessionTitle");
  const detail = document.getElementById("sessionDetail");
  const toggle = document.getElementById("sessionToggle");

  card.classList.toggle("active", session.active);
  if (session.active) {
    title.textContent = "Capturing";
    detail.textContent = `Since ${fmtClock(session.startedAt)} · ${pages(session.count)} saved. Just browse, there's nothing to click on each page.`;
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
  if (!confirm("Delete all saved pages? This can't be undone.")) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_CAPTURES" });
  renderCaptures();
});

// Captures land while the popup is open (the session keeps running).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.backpack_session) renderSession();
  if (changes.backpack_captures) renderCaptures();
});

renderSites();
renderTabNote();
renderSession();
renderCaptures();
