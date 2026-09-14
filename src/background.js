/*
 * Backpack Capture — background service worker.
 *
 * Owns the local capture store (chrome.storage.local) and the JSON export.
 * Never touches the network — this extension has no server and no API
 * calls anywhere in it; captures leave the browser only when the parent
 * explicitly exports them.
 */
const STORAGE_KEY = "backpack_captures";
const MAX_CAPTURES = 500; // simple cap so storage.local never grows unbounded

async function getCaptures() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || [];
}

async function setCaptures(captures) {
  await chrome.storage.local.set({ [STORAGE_KEY]: captures });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "STORE_CAPTURE") {
    (async () => {
      const captures = await getCaptures();
      captures.unshift(message.envelope);
      if (captures.length > MAX_CAPTURES) captures.length = MAX_CAPTURES;
      await setCaptures(captures);
      sendResponse({ ok: true });
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
      const filename = `backpack-captures-${new Date().toISOString().slice(0, 10)}.json`;
      const downloadId = await chrome.downloads.download({ url, filename, saveAs: true });
      sendResponse({ ok: true, downloadId });
    })();
    return true;
  }

  if (message && message.type === "TRIGGER_MANUAL_CAPTURE") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url || !tab.url.startsWith("https://classroom.google.com/")) {
        sendResponse({ ok: false, error: "not_classroom_tab" });
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
