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
      const isSupportedTab =
        tab && tab.url && (tab.url.startsWith("https://classroom.google.com/") || /\/genesis\/parents/i.test(tab.url));
      if (!isSupportedTab) {
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
