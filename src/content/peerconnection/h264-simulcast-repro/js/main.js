/*
 *  Copyright (c) 2026 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */

'use strict';

const startButton = document.getElementById('startButton');
const callButton = document.getElementById('callButton');
const highMiddleButton = document.getElementById('highMiddleButton');
const dual540Button = document.getElementById('dual540Button');
const highTopButton = document.getElementById('highTopButton');
const dual720Button = document.getElementById('dual720Button');
const hangupButton = document.getElementById('hangupButton');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const statusElement = document.getElementById('status');
const settingsElement = document.getElementById('settings');
const statsBody = document.getElementById('statsBody');
const resultElement = document.getElementById('result');

const ridToIndex = new Map([
  ['q', 0],
  ['h', 1],
  ['f', 2],
]);
let logicalIndexByRid = new Map(ridToIndex);

let localStream;
let senderPc;
let receiverPc;
let videoSender;
let statsTimer;
let currentMode = 'not configured';
let previousStats = new Map();
let stalledSamples = new Map();

startButton.onclick = start;
callButton.onclick = call;
highMiddleButton.onclick = () => applyMode('540 only on index 1', [
  {active: false, scale: 4, maxBitrate: 160000},
  {active: true, scale: 1, maxBitrate: 880000},
  {active: false, scale: 1, maxBitrate: 880000},
]);
dual540Button.onclick = () => applyMode('360 + 540 on indexes 1 and 2', [
  {active: false, scale: 4, maxBitrate: 160000},
  {active: true, scale: 640 / 560, maxBitrate: 640000},
  {active: true, scale: 1, maxBitrate: 880000},
]);
highTopButton.onclick = () => applyMode('720 class on index 2', [
  {active: false, scale: 4, maxBitrate: 160000},
  {active: false, scale: 640 / 560, maxBitrate: 640000},
  {active: true, scale: 1, maxBitrate: 2500000},
]);
dual720Button.onclick = () => applyMode('360 + 720 class on indexes 1 and 2', [
  {active: false, scale: 4, maxBitrate: 160000},
  {active: true, scale: 640 / 560, maxBitrate: 640000},
  {active: true, scale: 1, maxBitrate: 2500000},
]);
hangupButton.onclick = hangup;

async function start() {
  startButton.disabled = true;
  setStatus('Requesting a 640×480 camera stream...');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: {exact: 640},
        height: {exact: 480},
        frameRate: {ideal: 30},
      },
    });
  } catch (error) {
    startButton.disabled = false;
    setStatus(`Camera request failed: ${error.name}: ${error.message}`);
    return;
  }

  localVideo.srcObject = localStream;
  const track = localStream.getVideoTracks()[0];
  settingsElement.textContent =
    `Camera settings: ${JSON.stringify(track.getSettings(), null, 2)}`;
  callButton.disabled = false;
  setStatus('Camera ready. Create the loopback H.264 call.');
}

async function call() {
  callButton.disabled = true;
  senderPc = new RTCPeerConnection();
  receiverPc = new RTCPeerConnection();

  senderPc.onicecandidate = event => {
    if (event.candidate) {
      receiverPc.addIceCandidate(event.candidate);
    }
  };
  receiverPc.onicecandidate = event => {
    if (event.candidate) {
      senderPc.addIceCandidate(event.candidate);
    }
  };
  receiverPc.ontrack = event => {
    remoteVideo.srcObject = event.streams[0];
  };

  const track = localStream.getVideoTracks()[0];
  const transceiver = senderPc.addTransceiver(track, {
    direction: 'sendonly',
    streams: [localStream],
    sendEncodings: [
      {rid: 'q', active: false, scaleResolutionDownBy: 4, maxBitrate: 160000},
      {rid: 'h', active: true, scaleResolutionDownBy: 1, maxBitrate: 880000},
      {rid: 'f', active: false, scaleResolutionDownBy: 1, maxBitrate: 880000},
    ],
  });
  videoSender = transceiver.sender;

  try {
    preferH264(transceiver);
    const offer = await senderPc.createOffer();
    await senderPc.setLocalDescription(offer);
    await receiverPc.setRemoteDescription(offer);
    preferH264(receiverPc.getTransceivers()[0]);
    const answer = await receiverPc.createAnswer();
    await receiverPc.setLocalDescription(answer);
    await senderPc.setRemoteDescription(answer);
  } catch (error) {
    setStatus(`H.264 negotiation failed: ${error.name}: ${error.message}`);
    hangup();
    return;
  }

  const parameters = videoSender.getParameters();
  const codec = parameters.codecs.find(item =>
    item.mimeType.toLowerCase() === 'video/h264');
  if (!codec) {
    setStatus('The negotiated sender does not contain H.264.');
    hangup();
    return;
  }

  currentMode = '540 only on index 1';
  setModeButtonsDisabled(false);
  hangupButton.disabled = false;
  previousStats = new Map();
  stalledSamples = new Map();
  statsTimer = window.setInterval(updateStats, 1000);
  await updateStats();
  setStatus(`Connected with ${codec.mimeType}. Start with 540 only, then select 360 + 540.`);
}

function preferH264(transceiver) {
  if (!transceiver || !transceiver.setCodecPreferences) {
    throw new Error('setCodecPreferences() is not supported');
  }

  const capabilities = RTCRtpSender.getCapabilities('video');
  const h264Codecs = capabilities.codecs.filter(codec =>
    codec.mimeType.toLowerCase() === 'video/h264');
  if (h264Codecs.length === 0) {
    throw new Error('H.264 is not supported');
  }
  transceiver.setCodecPreferences(h264Codecs);
}

async function applyMode(name, requestedEncodings) {
  const parameters = videoSender.getParameters();
  if (parameters.encodings.length === 2) {
    logicalIndexByRid = new Map(parameters.encodings.map((encoding, index) =>
      [encoding.rid, index + 1]));
  } else {
    logicalIndexByRid = new Map(ridToIndex);
  }
  let effectiveEncodings = requestedEncodings;

  // Some browser-to-browser answers retain only the two highest RIDs. Those
  // correspond to WCME's affected logical indexes 1 and 2, so the transition
  // can still be tested without the unused lowest encoding.
  if (parameters.encodings.length === 2 && requestedEncodings.length === 3) {
    effectiveEncodings = requestedEncodings.slice(1);
  }

  if (parameters.encodings.length < effectiveEncodings.length) {
    setStatus(`Expected 3 encodings, but the browser exposes ${parameters.encodings.length}.`);
    return;
  }

  effectiveEncodings.forEach((requested, index) => {
    const encoding = parameters.encodings[index];
    encoding.active = requested.active;
    encoding.maxBitrate = requested.maxBitrate;
    encoding.scaleResolutionDownBy = requested.scale;
  });

  try {
    await videoSender.setParameters(parameters);
    currentMode = name;
    previousStats = new Map();
    stalledSamples = new Map();
    resultElement.textContent = `Running "${name}"...`;
    const mapping = parameters.encodings.length === 2 ?
      ' Using the two available encodings as indexes 1 and 2.' : '';
    setStatus(`setParameters() accepted "${name}".${mapping}`);
    await updateStats();
  } catch (error) {
    setStatus(`setParameters() failed: ${error.name}: ${error.message}`);
  }
}

async function updateStats() {
  if (!videoSender) return;

  const parameters = videoSender.getParameters();
  const encodingByRid = new Map(parameters.encodings.map(encoding =>
    [encoding.rid, encoding]));
  const report = await videoSender.getStats();
  const outboundStats = [];

  report.forEach(stat => {
    if (stat.type === 'outbound-rtp' && stat.kind === 'video' && !stat.isRemote) {
      outboundStats.push(stat);
    }
  });

  outboundStats.sort((left, right) =>
    getEncodingIndex(left) - getEncodingIndex(right));

  const rows = outboundStats.map(stat => {
    const encoding = encodingByRid.get(stat.rid);
    const active = encoding ? encoding.active : stat.active;
    const previous = previousStats.get(stat.ssrc);
    const frameDelta = previous ? stat.framesEncoded - previous.framesEncoded : 0;
    const packetDelta = previous ? stat.packetsSent - previous.packetsSent : 0;
    const advancing = frameDelta > 0 || packetDelta > 0;
    const oldStalledSamples = stalledSamples.get(stat.ssrc) || 0;
    const stalledCount = active && previous && !advancing ? oldStalledSamples + 1 : 0;
    stalledSamples.set(stat.ssrc, stalledCount);
    previousStats.set(stat.ssrc, {
      framesEncoded: stat.framesEncoded,
      packetsSent: stat.packetsSent,
    });

    return {
      stat,
      encoding,
      active,
      advancing,
      stalled: stalledCount >= 3,
    };
  });

  renderStats(rows);
  detectReproduction(rows);
}

function getEncodingIndex(stat) {
  if (logicalIndexByRid.has(stat.rid)) return logicalIndexByRid.get(stat.rid);
  if (Number.isInteger(stat.encodingIndex)) return stat.encodingIndex;
  return 99;
}

function renderStats(rows) {
  statsBody.textContent = '';

  rows.forEach(row => {
    const tableRow = document.createElement('tr');
    const index = getEncodingIndex(row.stat);
    const output = row.stat.frameWidth && row.stat.frameHeight ?
      `${row.stat.frameWidth}×${row.stat.frameHeight}` : '—';
    const requested = row.encoding ?
      `active=${row.encoding.active}, scale=${formatNumber(row.encoding.scaleResolutionDownBy)}, ` +
        `max=${formatBitrate(row.encoding.maxBitrate)}` :
      `active=${row.active}`;
    const counterState = row.stalled ? 'STALLED' :
      row.advancing ? 'advancing' : 'waiting';

    appendCell(tableRow, `${row.stat.rid || 'unknown'} / ${index}`);
    appendCell(tableRow, requested);
    appendCell(tableRow, output);
    appendCell(tableRow, formatBitrate(row.stat.targetBitrate));
    appendCell(tableRow, row.stat.framesEncoded);
    appendCell(tableRow, row.stat.packetsSent);
    appendCell(tableRow, formatNumber(row.stat.totalEncodeTime));
    appendCell(tableRow, counterState, row.stalled ? 'stalled' :
      row.advancing ? 'advancing' : '');
    statsBody.appendChild(tableRow);
  });
}

function detectReproduction(rows) {
  const stalled = rows.find(row => row.active && row.stalled);
  const advancingSibling = rows.find(row =>
    row.active && row.advancing && row !== stalled);
  if (!stalled || !advancingSibling) return;

  const highIndex = getEncodingIndex(stalled.stat);
  const siblingIndex = getEncodingIndex(advancingSibling.stat);
  resultElement.textContent =
    `Issue reproduced in "${currentMode}".\n` +
    `Index ${highIndex} is active but is not sending video.\n` +
    `Index ${siblingIndex} continues sending.`;
}

function appendCell(row, value, className = '') {
  const cell = document.createElement('td');
  cell.textContent = value === undefined ? '—' : value;
  cell.className = className;
  row.appendChild(cell);
}

function formatBitrate(value) {
  if (value === undefined || value === null) return '—';
  return `${Math.round(value / 1000)} kbps`;
}

function formatNumber(value) {
  if (value === undefined || value === null) return '—';
  return Math.round(value * 1000) / 1000;
}

function setStatus(message) {
  statusElement.textContent = message;
  console.log(message);
}

function setModeButtonsDisabled(disabled) {
  highMiddleButton.disabled = disabled;
  dual540Button.disabled = disabled;
  highTopButton.disabled = disabled;
  dual720Button.disabled = disabled;
}

function hangup() {
  if (statsTimer) {
    window.clearInterval(statsTimer);
    statsTimer = null;
  }
  if (senderPc) senderPc.close();
  if (receiverPc) receiverPc.close();
  senderPc = null;
  receiverPc = null;
  videoSender = null;
  remoteVideo.srcObject = null;
  statsBody.textContent = '';
  setModeButtonsDisabled(true);
  hangupButton.disabled = true;
  callButton.disabled = !localStream;
  setStatus('Call ended.');
}
