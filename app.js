import { inspectAndClean } from "./cleaner.js?v=hdr-preserve-3";
import { shareWithFallback } from "./share.js?v=hdr-preserve-3";

const input = document.querySelector("#file-input");
const dropZone = document.querySelector("#drop-zone");
const result = document.querySelector("#result");
const fileName = document.querySelector("#file-name");
const fileSummary = document.querySelector("#file-summary");
const hdrSummary = document.querySelector("#hdr-summary");
const hdrStatus = document.querySelector("#hdr-status");
const hdrCheckRow = document.querySelector("#hdr-check-row");
const byteSummary = document.querySelector("#byte-summary");
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
    : /iPhone|iPad|iPod/i.test(navigator.userAgent)
      ? "Choose from Files (not Photo Library) to avoid automatic SDR conversion"
      : "or choose a MOV or MP4 file";
}

function showMessage(text, isError = false, isWarning = false) {
  message.textContent = text;
  message.classList.toggle("is-error", isError);
  message.classList.toggle("is-warning", isWarning);
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

function hdrSourceStatus(media) {
  const video = media.video;
  if (!video) return { state: "unknown", text: "No video track found." };
  if (video.dolbyVision) return { state: "hdr", text: "Dolby Vision configuration preserved." };
  const transfer = video.color?.transfer;
  if (transfer === 16) return { state: "hdr", text: "HDR PQ (ST 2084) color signaling preserved." };
  if (transfer === 18) return { state: "hdr", text: "HLG color signaling preserved." };
  if ([1, 6, 13, 14, 15].includes(transfer)) return {
    state: "sdr",
    text: "The selected source is signaled as SDR (transfer " + transfer +
      "). If it plays in HDR in Photos, the picker may have converted it. Use Files."
  };
  return {
    state: "unknown",
    text: "No recognized HDR indicator in the container. HDR may be in the HEVC bitstream; those bytes are preserved."
  };
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
  const hdr = hdrSourceStatus(report.media);
  hdrSummary.textContent = hdr.text;
  hdrStatus.textContent = hdr.state === "hdr" ? "Source HDR signaling preserved"
    : hdr.state === "sdr" ? "Selected source is SDR" : "Source HDR status undetermined";
  hdrCheckRow.classList.toggle("verification-warning", hdr.state !== "hdr");
  hdrCheckRow.querySelector(".check").textContent = hdr.state === "hdr" ? "✓" : "?";
  byteSummary.textContent = "Input " + report.file.size.toLocaleString() +
    " bytes · Clean " + report.file.outputSize.toLocaleString() +
    " bytes · Same exact length";
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
  saveButton.textContent = onAppleMobile ? "Save or share clean video" : "Download clean video";
  saveHint.textContent = onAppleMobile
    ? "Opens the iPhone share sheet, as before. Choose Save Video or Save to Files."
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
    const hdr = hdrSourceStatus(output.report.media);
    if (hdr.state === "sdr") {
      showMessage("The selected input is SDR. The cleaner cannot recover HDR lost before import. On iPhone, choose the original from Files, not Photo Library.", false, true);
    } else {
      showMessage(output.changed ? "Clean copy is ready." : "No identifiable CapCut metadata was found; the original media was left unchanged.");
    }
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

async function saveOutput() {
  if (!output) return;
  await shareWithFallback(output, navigator, downloadOutput);
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
