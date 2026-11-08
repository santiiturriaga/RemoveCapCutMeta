import { inspectAndClean } from "./cleaner.js?v=hdr-preserve-2";

const input = document.querySelector("#file-input");
const dropZone = document.querySelector("#drop-zone");
const result = document.querySelector("#result");
const fileName = document.querySelector("#file-name");
const fileSummary = document.querySelector("#file-summary");
const hdrSummary = document.querySelector("#hdr-summary");
const outputMetadataSummary = document.querySelector("#output-metadata-summary");
const saveButton = document.querySelector("#save-button");
const saveHint = document.querySelector("#save-hint");
const newFileButton = document.querySelector("#new-file-button");
const message = document.querySelector("#message");
const inspectorEmpty = document.querySelector("#inspector-empty");
const inspectorContent = document.querySelector("#inspector-content");
const detectedSource = document.querySelector("#detected-source");
const detectedBadge = document.querySelector("#detected-badge");
const detectedDescription = document.querySelector("#detected-description");
const culpritCard = document.querySelector("#culprit-card");
const culpritTitle = document.querySelector("#culprit-title");
const culpritKey = document.querySelector("#culprit-key");
const culpritSummary = document.querySelector("#culprit-summary");
const culpritDetails = document.querySelector("#culprit-details");
const removedCount = document.querySelector("#removed-count");
const removedList = document.querySelector("#removed-list");
const inputCount = document.querySelector("#input-count");
const inputList = document.querySelector("#input-list");

let output = null;

function setBusy(busy) {
  dropZone.disabled = busy;
  dropZone.querySelector(".drop-title").textContent = busy ? "Inspecting and cleaning…" : "Drop a video here";
  dropZone.querySelector(".drop-subtitle").textContent = busy
    ? "The file never leaves this device"
    : "or choose a MOV or MP4 file";
}

function showMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("is-error", isError);
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 || unit === "B" ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  const remaining = rounded % 60;
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function videoDescription(media) {
  const video = media.video;
  if (!video) return "Media structure preserved";
  const parts = [];
  if (video.codec) parts.push(video.codec.toUpperCase());
  if (video.bitDepth) parts.push(`${video.bitDepth}-bit`);
  if (video.dimensions) parts.push(`${video.dimensions.width} × ${video.dimensions.height}`);
  if (video.color?.transfer === 16) parts.push("PQ HDR");
  else if (video.color?.transfer === 18) parts.push("HLG HDR");
  if (video.dolbyVision) parts.push(`Dolby Vision Profile ${video.dolbyVision.profile}`);
  return parts.join(" · ");
}

function hdrDescription(media) {
  const video = media.video;
  if (!video) return "No video track found.";
  if (video.dolbyVision) return "Dolby Vision configuration preserved byte-for-byte.";
  if (video.color?.transfer === 16) return "HDR PQ (ST 2084) transfer and codec configuration preserved byte-for-byte.";
  if (video.color?.transfer === 18) return "HDR HLG transfer and codec configuration preserved byte-for-byte.";
  if (video.color) return "Source color transfer is " + video.color.transfer +
    "; all codec/color configuration is preserved. Not labeled HDR.";
  return "HDR status unknown from container alone; codec and color configuration bytes are unchanged.";
}

function makeMetadataItem(entry, includeReason = true) {
  const item = document.createElement("div");
  item.className = "metadata-item";

  const head = document.createElement("div");
  head.className = "metadata-item-head";

  const key = document.createElement("span");
  key.className = "metadata-key";
  key.textContent = entry.key;

  const type = document.createElement("span");
  type.className = "metadata-type";
  type.textContent = entry.type;

  head.append(key, type);
  item.append(head);

  if (entry.displayValue) {
    const value = document.createElement("p");
    value.className = "metadata-value";
    value.textContent = entry.displayValue.length > 180 ? `${entry.displayValue.slice(0, 177)}…` : entry.displayValue;
    item.append(value);
  }

  if (includeReason) {
    const reason = document.createElement("p");
    reason.className = "metadata-reason";
    reason.textContent = entry.reason;
    item.append(reason);
  }

  return item;
}

function renderList(container, entries, includeReason = true) {
  container.replaceChildren(...entries.map((entry) => makeMetadataItem(entry, includeReason)));
}

function renderCulprit(culprit) {
  if (!culprit) {
    culpritCard.hidden = true;
    return;
  }

  culpritCard.hidden = false;
  culpritTitle.textContent = "Embedded editor export fingerprint";
  culpritKey.textContent = culprit.key;
  culpritSummary.textContent = culprit.reason;
  culpritDetails.replaceChildren();

  for (const [label, value] of Object.entries(culprit.details || {})) {
    if (!value) continue;
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = label;
    dd.textContent = value;
    culpritDetails.append(dt, dd);
  }
}

function renderReport(report) {
  const duration = formatDuration(report.file.duration);
  fileName.textContent = report.file.outputName;
  fileSummary.textContent = [report.file.container, formatBytes(report.file.size), duration, videoDescription(report.media)]
    .filter(Boolean)
    .join(" · ");
  hdrSummary.textContent = hdrDescription(report.media);
  outputMetadataSummary.textContent = "Only identified CapCut/ByteDance fields are removed; unrelated metadata is retained.";

  const detection = report.detection;
  if (detection.editor) {
    detectedSource.textContent = detection.editor;
    detectedBadge.hidden = false;
    detectedDescription.textContent = `${detection.identifiers.length} editor-specific identifier${detection.identifiers.length === 1 ? "" : "s"} found. The strongest one is highlighted below.`;
  } else {
    detectedSource.textContent = "No known editor fingerprint";
    detectedBadge.hidden = true;
    detectedDescription.textContent = "No known CapCut, Vicut, ByteDance, or Dreamina marker was found. Unrelated metadata is preserved.";
  }

  renderCulprit(detection.culprit);
  removedCount.textContent = `${report.metadata.removed.length} field${report.metadata.removed.length === 1 ? "" : "s"}`;
  inputCount.textContent = `(${report.metadata.inputCount})`;
  const identifiers = report.metadata.removed.filter((entry) =>
    ["Editor fingerprint", "ByteDance flag", "Dreamina marker", "Vendor flag", "Editor identifier"].includes(entry.type)
  );
  const otherCount = report.metadata.removed.length - identifiers.length;
  const visibleRemoved = [...identifiers];
  if (otherCount > 0) {
    visibleRemoved.push({
      key: `${otherCount} additional field${otherCount === 1 ? "" : "s"}`,
      type: "Recognized editor metadata",
      displayValue: "Additional identifiable editor fields",
      reason: "Removed only when they match known CapCut/ByteDance identifiers."
    });
  }
  renderList(removedList, visibleRemoved, true);
  renderList(inputList, report.metadata.input, false);

  inspectorEmpty.hidden = true;
  inspectorContent.hidden = false;
  result.hidden = false;
  dropZone.hidden = true;

  const onAppleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  saveButton.textContent = "Download clean video";
  saveHint.textContent = onAppleMobile
    ? "Downloads the MP4/MOV bytes directly to Files; sharing through other apps may change HDR."
    : `Downloads as ${report.file.outputName.split(".").pop().toUpperCase()}.`;
}

async function handleFile(file) {
  dropZone.hidden = false;
  result.hidden = true;
  output = null;
  showMessage("");
  setBusy(true);

  try {
    output = await inspectAndClean(file);
    renderReport(output.report);
    showMessage(output.changed ? "Clean copy is ready." : "No identifiable CapCut metadata was found; the original media was left unchanged.");
  } catch (error) {
    showMessage(error instanceof Error ? error.message : "The video could not be cleaned.", true);
  } finally {
    setBusy(false);
    input.value = "";
  }
}

function downloadOutput() {
  const url = URL.createObjectURL(output.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = output.name;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function saveOutput() {
  if (!output) return;
  // Do not round-trip the output through another app's native share pipeline:
  // destinations such as photo editors may create a new SDR/transcoded asset.
  downloadOutput();
}

function chooseAnother() {
  input.click();
}

dropZone.addEventListener("click", () => input.click());
newFileButton.addEventListener("click", chooseAnother);
input.addEventListener("change", () => {
  const [file] = input.files;
  if (file) handleFile(file);
});

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  });
}

dropZone.addEventListener("drop", (event) => {
  const [file] = event.dataTransfer.files;
  if (file) handleFile(file);
});

saveButton.addEventListener("click", saveOutput);
