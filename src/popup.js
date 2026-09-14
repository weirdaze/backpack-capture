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

async function render() {
  const { captures } = await chrome.runtime.sendMessage({ type: "GET_CAPTURES" });
  const list = document.getElementById("captureList");
  const empty = document.getElementById("emptyState");
  list.innerHTML = "";

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
      render();
    });
    rowActions.appendChild(delBtn);
    li.appendChild(rowActions);

    list.appendChild(li);
  }
}

document.getElementById("captureNow").addEventListener("click", async () => {
  setStatus("Capturing…");
  const result = await chrome.runtime.sendMessage({ type: "TRIGGER_MANUAL_CAPTURE" });
  if (result && result.ok) {
    setStatus("");
    setTimeout(render, 500);
  } else {
    setStatus(
      result && result.error === "unsupported_tab"
        ? "Open a Classroom or Genesis tab first."
        : "Capture failed — reload the tab and try again."
    );
  }
});

document.getElementById("exportJson").addEventListener("click", async () => {
  setStatus("Exporting…");
  const result = await chrome.runtime.sendMessage({ type: "EXPORT_CAPTURES" });
  setStatus(result && result.ok ? "Exported." : "Export failed.");
});

document.getElementById("clearAll").addEventListener("click", async () => {
  if (!confirm("Delete all locally stored captures? This can't be undone.")) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_CAPTURES" });
  render();
});

render();
