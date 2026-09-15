/*
 * Backpack Capture — background service worker.
 *
 * Owns the local capture store (chrome.storage.local), the capture session
 * (Start/End capture), and the export. Never touches the network — this
 * extension has no server and no API calls anywhere in it; captures leave
 * the browser only when the parent explicitly exports them.
 */
importScripts("supported-sites.js");

const STORAGE_KEY = "backpack_captures";
const SESSION_KEY = "backpack_session"; // also read by core-content.js
const MAX_CAPTURES = 500; // simple cap so storage.local never grows unbounded
const IDLE_SESSION = { active: false, startedAt: null, count: 0 };

async function getCaptures() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || [];
}

async function setCaptures(captures) {
  await chrome.storage.local.set({ [STORAGE_KEY]: captures });
}

async function getSession() {
  const data = await chrome.storage.local.get(SESSION_KEY);
  return { ...IDLE_SESSION, ...(data[SESSION_KEY] || {}) };
}

async function showSessionBadge(session) {
  await chrome.action.setBadgeText({ text: session.active ? "REC" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#c62828" });
  await chrome.action.setTitle({
    title: session.active
      ? "Backpack Capture: capturing Google Classroom and Genesis pages"
      : "Backpack Capture: not capturing",
  });
}

async function saveSession(session) {
  await chrome.storage.local.set({ [SESSION_KEY]: session });
  await showSessionBadge(session);
}

// A session never survives a browser restart, so capture is never left
// running for days by someone who forgot to press End.
chrome.runtime.onStartup.addListener(async () => {
  const session = await getSession();
  await saveSession({ ...session, active: false });
});

chrome.runtime.onInstalled.addListener(async () => {
  await showSessionBadge(await getSession());
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "STORE_CAPTURE") {
    (async () => {
      const captures = await getCaptures();
      captures.unshift(message.envelope);
      if (captures.length > MAX_CAPTURES) captures.length = MAX_CAPTURES;
      await setCaptures(captures);
      const session = await getSession();
      if (session.active) await saveSession({ ...session, count: session.count + 1 });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message && message.type === "START_SESSION") {
    (async () => {
      const session = { active: true, startedAt: new Date().toISOString(), count: 0 };
      await saveSession(session);
      sendResponse({ ok: true, session });
    })();
    return true;
  }

  if (message && message.type === "END_SESSION") {
    (async () => {
      const session = { ...(await getSession()), active: false };
      await saveSession(session);
      sendResponse({ ok: true, session });
    })();
    return true;
  }

  if (message && message.type === "GET_SESSION") {
    (async () => {
      sendResponse({ ok: true, session: await getSession() });
    })();
    return true;
  }

  if (message && message.type === "DELETE_CAPTURE") {
    (async () => {
      const captures = await getCaptures();
      await setCaptures(captures.filter((c) => c.id !== message.id));
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message && message.type === "CLEAR_CAPTURES") {
    (async () => {
      await setCaptures([]);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message && message.type === "GET_CAPTURES") {
    (async () => {
      sendResponse({ ok: true, captures: await getCaptures() });
    })();
    return true;
  }

  if (message && message.type === "EXPORT_CAPTURES") {
    (async () => {
      const captures = await getCaptures();
      const payload = JSON.stringify({ exported_at: new Date().toISOString(), captures }, null, 2);
      const url = `data:application/json;base64,${btoa(unescape(encodeURIComponent(payload)))}`;
      // Include time, not just date - re-exporting later the same day
      // previously overwrote the earlier file (with saveAs, only if the
      // user keeps the suggested name), losing whatever the earlier
      // export had already captured for diagnosis.
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `backpack-captures-${stamp}.json`;
      const downloadId = await chrome.downloads.download({ url, filename, saveAs: true });
      sendResponse({ ok: true, downloadId });
    })();
    return true;
  }

  if (message && message.type === "TRIGGER_MANUAL_CAPTURE") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !self.BackpackSites.supportedSite(tab.url)) {
        sendResponse({ ok: false, error: "unsupported_tab" });
        return;
      }
      try {
        const result = await chrome.tabs.sendMessage(tab.id, { type: "MANUAL_CAPTURE" });
        sendResponse(result || { ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  return undefined;
});
